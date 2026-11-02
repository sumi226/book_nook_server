import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import mongoose from "mongoose";
import { z } from "zod";
import { config } from "./config.js";
import {
  resolveAuthSession,
  type AuthenticatedUser,
} from "./auth.js";
import { HttpError } from "./errors.js";
import { Book, Borrow } from "./models.js";

type SessionResolver = (request: Request) => Promise<AuthenticatedUser | null>;

const bookInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    author: z.string().trim().min(1).max(160),
    category: z.string().trim().min(1).max(80),
    image: z.string().trim().url().max(2048).refine(
      (value) => value.startsWith("https://") || value.startsWith("http://"),
      "Image URL must use HTTP or HTTPS",
    ),
    description: z.string().trim().min(1).max(5000),
    totalCopies: z.number().int().min(1),
    availableCopies: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((book, context) => {
    if (
      book.availableCopies !== undefined &&
      book.availableCopies !== book.totalCopies
    ) {
      context.addIssue({
        code: "custom",
        path: ["availableCopies"],
        message: "New books must have all copies available",
      });
    }
  });

const bookPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    author: z.string().trim().min(1).max(160).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    image: bookInputSchema.shape.image.optional(),
    description: z.string().trim().min(1).max(5000).optional(),
    totalCopies: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Provide at least one field to update",
  });

const borrowInputSchema = z
  .object({
    bookId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid book ID"),
    returnDate: z.string().min(1).refine(
      (value) => Number.isFinite(Date.parse(value)),
      "returnDate must be a valid date",
    ),
  })
  .strict();

function asyncHandler(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function requireAuth(
  resolveSession: SessionResolver,
  request: Request,
  response: Response,
  next: NextFunction,
) {
  void resolveSession(request)
    .then((user) => {
      if (!user) {
        next(new HttpError(401, "Authentication required"));
        return;
      }
      response.locals.user = user;
      next();
    })
    .catch(next);
}

function getUser(response: Response): AuthenticatedUser {
  return response.locals.user as AuthenticatedUser;
}

function requireFrontendOrigin(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  if (request.get("origin") !== config.FRONTEND_ORIGIN) {
    next(new HttpError(403, "Request origin is not allowed"));
    return;
  }
  next();
}

function getObjectId(value: string) {
  if (!mongoose.isObjectIdOrHexString(value)) {
    throw new HttpError(400, "Invalid resource ID");
  }
  return new mongoose.Types.ObjectId(value);
}

function getRouteParam(value: string | string[] | undefined) {
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid resource ID");
  }
  return value;
}

function bookResponse(book: Record<string, unknown> | { toObject(): object }) {
  const record =
    "toObject" in book && typeof book.toObject === "function"
      ? book.toObject()
      : book;
  const { _id, __v: _version, ...fields } = record as Record<string, unknown>;
  return { id: String(_id), ...fields };
}

function borrowResponse(
  borrow: Record<string, unknown> | { toObject(): object },
) {
  const record =
    "toObject" in borrow && typeof borrow.toObject === "function"
      ? borrow.toObject()
      : borrow;
  const {
    _id,
    __v: _version,
    activeKey: _activeKey,
    ...fields
  } = record as Record<string, unknown>;
  return { id: String(_id), ...fields };
}

async function inTransaction<T>(operation: (session: mongoose.ClientSession) => Promise<T>) {
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(() => operation(session));
    if (result === undefined) {
      throw new Error("Database transaction completed without a result");
    }
    return result;
  } finally {
    await session.endSession();
  }
}

export function createApp(
  resolveSession: SessionResolver = resolveAuthSession,
) {
  const app = express();
  const authenticated = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => requireAuth(resolveSession, request, response, next);

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: config.FRONTEND_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use(
    "/",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );

  app.get(
    "/books",
    asyncHandler(async (_request, response) => {
      const books = await Book.find().sort({ createdAt: -1 }).lean();
      response.status(200).json(books.map(bookResponse));
    }),
  );

  app.get(
    "/books/:id",
    asyncHandler(async (request, response) => {
      const book = await Book.findById(
        getObjectId(getRouteParam(request.params.id)),
      );
      if (!book) throw new HttpError(404, "Book not found");
      response.status(200).json(bookResponse(book));
    }),
  );

  app.post(
    "/books",
    authenticated,
    requireFrontendOrigin,
    asyncHandler(async (_request, response) => {
      const input = bookInputSchema.parse(_request.body);
      const user = getUser(response);
      const book = await Book.create({
        ...input,
        availableCopies: input.totalCopies,
        addedByName: user.name,
        addedByEmail: user.email,
      });
      response.status(201).json(bookResponse(book));
    }),
  );

  app.patch(
    "/books/:id",
    authenticated,
    requireFrontendOrigin,
    asyncHandler(async (request, response) => {
      const patch = bookPatchSchema.parse(request.body);
      const user = getUser(response);
      const bookId = getObjectId(getRouteParam(request.params.id));
      const updated = await inTransaction(async (session) => {
        const current = await Book.findOne({
          _id: bookId,
          addedByEmail: user.email,
        }).session(session);
        if (!current) throw new HttpError(404, "Book not found");

        const update: Record<string, unknown> = { $set: { ...patch } };
        if (patch.totalCopies !== undefined) {
          const changeInCopies = patch.totalCopies - current.totalCopies;
          if (current.availableCopies + changeInCopies < 0) {
            throw new HttpError(
              409,
              "Total copies cannot be lower than the number already borrowed",
            );
          }
          update.$inc = { availableCopies: changeInCopies };
        }

        const result = await Book.findOneAndUpdate(
          {
            _id: bookId,
            addedByEmail: user.email,
            totalCopies: current.totalCopies,
            availableCopies: current.availableCopies,
          },
          update,
          { new: true, runValidators: true, session },
        );
        if (!result) throw new HttpError(409, "Book changed; retry the update");
        return result;
      });
      response.status(200).json(bookResponse(updated));
    }),
  );

  app.delete(
    "/books/:id",
    authenticated,
    requireFrontendOrigin,
    asyncHandler(async (request, response) => {
      const user = getUser(response);
      const bookId = getObjectId(getRouteParam(request.params.id));
      await inTransaction(async (session) => {
        const book = await Book.findOne({
          _id: bookId,
          addedByEmail: user.email,
        }).session(session);
        if (!book) throw new HttpError(404, "Book not found");

        const activeBorrow = await Borrow.exists({
          bookId,
          activeKey: { $exists: true },
        }).session(session);
        if (activeBorrow) {
          throw new HttpError(409, "Cannot delete a book with active borrows");
        }

        await Book.deleteOne({ _id: bookId }, { session });
      });
      response.status(204).end();
    }),
  );

  app.post(
    "/borrows",
    authenticated,
    requireFrontendOrigin,
    asyncHandler(async (request, response) => {
      const input = borrowInputSchema.parse(request.body);
      const returnDate = new Date(input.returnDate);
      if (returnDate <= new Date()) {
        throw new HttpError(400, "returnDate must be in the future");
      }
      const user = getUser(response);
      const bookId = getObjectId(input.bookId);

      const borrow = await inTransaction(async (session) => {
        const book = await Book.findOneAndUpdate(
          { _id: bookId, availableCopies: { $gt: 0 } },
          { $inc: { availableCopies: -1 } },
          { new: true, session },
        );
        if (!book) {
          const exists = await Book.exists({ _id: bookId }).session(session);
          if (!exists) throw new HttpError(404, "Book not found");
          throw new HttpError(409, "No copies are currently available");
        }

        const activeKey = `${bookId.toString()}:${user.email}`;
        const [created] = await Borrow.create(
          [
            {
              bookId,
              bookTitle: book.title,
              bookImage: book.image,
              userEmail: user.email,
              borrowDate: new Date(),
              returnDate,
              activeKey,
            },
          ],
          { session },
        );
        return created;
      });
      response.status(201).json(borrowResponse(borrow));
    }),
  );

  app.get(
    "/borrows",
    authenticated,
    asyncHandler(async (_request, response) => {
      const borrows = await Borrow.find({
        userEmail: getUser(response).email,
      })
        .sort({ borrowDate: -1 })
        .lean();
      response.status(200).json(borrows.map(borrowResponse));
    }),
  );

  app.delete(
    "/borrows/:id",
    authenticated,
    requireFrontendOrigin,
    asyncHandler(async (request, response) => {
      const user = getUser(response);
      const borrowId = getObjectId(getRouteParam(request.params.id));
      await inTransaction(async (session) => {
        const borrow = await Borrow.findOneAndUpdate(
          {
            _id: borrowId,
            userEmail: user.email,
            activeKey: { $exists: true },
          },
          { $unset: { activeKey: 1 }, $set: { returnedAt: new Date() } },
          { new: true, session },
        );
        if (!borrow) {
          const exists = await Borrow.exists({
            _id: borrowId,
            userEmail: user.email,
          }).session(session);
          if (!exists) throw new HttpError(404, "Active borrow not found");
          throw new HttpError(409, "This borrow has already been returned");
        }

        const book = await Book.findOneAndUpdate(
          { _id: borrow.bookId, $expr: { $lt: ["$availableCopies", "$totalCopies"] } },
          { $inc: { availableCopies: 1 } },
          { new: true, session },
        );
        if (!book) {
          throw new HttpError(409, "Book inventory cannot be safely restored");
        }
      });
      response.status(204).end();
    }),
  );

  app.use((_request, _response, next) => {
    next(new HttpError(404, "Route not found"));
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: "Request validation failed",
        details: error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof mongoose.Error.CastError) {
      response.status(400).json({ error: "Invalid resource ID" });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000
    ) {
      response.status(409).json({ error: "An active borrow already exists" });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Malformed JSON request body" });
      return;
    }

    console.error("Unhandled API error", error);
    response.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  return app;
}
