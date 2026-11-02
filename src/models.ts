import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const bookSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    author: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, required: true, trim: true, maxlength: 80 },
    image: { type: String, required: true, trim: true, maxlength: 2048 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    totalCopies: { type: Number, required: true, min: 1, validate: Number.isInteger },
    availableCopies: { type: Number, required: true, min: 0, validate: Number.isInteger },
    addedByName: { type: String, required: true, trim: true, maxlength: 160 },
    addedByEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

bookSchema.index({ createdAt: -1 }, { name: "books_newest_first" });
bookSchema.index({ category: 1 }, { name: "books_by_category" });

const borrowSchema = new Schema(
  {
    bookId: { type: Schema.Types.ObjectId, ref: "Book", required: true },
    bookTitle: { type: String, required: true, trim: true, maxlength: 200 },
    bookImage: { type: String, required: true, trim: true, maxlength: 2048 },
    userEmail: { type: String, required: true, trim: true, lowercase: true },
    borrowDate: { type: Date, required: true, default: Date.now },
    returnDate: { type: Date, required: true },
    returnedAt: { type: Date },
    activeKey: { type: String },
  },
  { versionKey: false },
);

borrowSchema.index(
  { activeKey: 1 },
  { unique: true, sparse: true, name: "one_active_borrow_per_user_and_book" },
);
borrowSchema.index({ userEmail: 1, borrowDate: -1 }, { name: "borrows_by_user" });
borrowSchema.index({ bookId: 1, activeKey: 1 }, { name: "active_borrows_by_book" });

type BookRecord = InferSchemaType<typeof bookSchema>;
type BorrowRecord = InferSchemaType<typeof borrowSchema>;

export const Book: Model<BookRecord> =
  (mongoose.models.Book as Model<BookRecord> | undefined) ??
  mongoose.model<BookRecord>("Book", bookSchema);
export const Borrow: Model<BorrowRecord> =
  (mongoose.models.Borrow as Model<BorrowRecord> | undefined) ??
  mongoose.model<BorrowRecord>("Borrow", borrowSchema);
