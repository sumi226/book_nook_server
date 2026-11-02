import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";

test("BookNook API validates and protects the books and borrow routes", async () => {
  const replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
  });
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const signingKey = {
    ...(await exportJWK(publicKey)),
    kid: "booknook-test-key",
    alg: "EdDSA",
    use: "sig",
  };
  const jwksServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [signingKey] }));
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", resolve);
  });
  const jwksAddress = jwksServer.address();
  assert.ok(jwksAddress && typeof jwksAddress !== "string");
  const issuer = "http://localhost:3000";
  Object.assign(process.env, {
    MONGODB_URI: replicaSet.getUri(),
    MONGODB_DB: "booknook_test",
    BETTER_AUTH_JWKS_URL: `http://127.0.0.1:${jwksAddress.port}/api/auth/jwks`,
    BETTER_AUTH_ISSUER: issuer,
    BETTER_AUTH_AUDIENCE: issuer,
    FRONTEND_ORIGIN: "http://localhost:3000",
    NODE_ENV: "test",
  });

  const [{ createApp }, database] = await Promise.all([
    import("./app.js"),
    import("./database.js"),
  ]);
  const reader = { email: "reader@example.com", name: "Reader" };
  const secondReader = { email: "second@example.com", name: "Second Reader" };
  const thirdReader = { email: "third@example.com", name: "Third Reader" };
  const app = createApp(async (req) => {
    if (req.get("cookie") === "session=reader") return reader;
    if (req.get("cookie") === "session=second") return secondReader;
    if (req.get("cookie") === "session=third") return thirdReader;
    return null;
  });
  const api = request(app);
  const asReader = (path: string) =>
    api.get(path).set("Cookie", "session=reader");
  const writeAsReader = (method: "post" | "patch" | "delete", path: string) =>
    api[method](path)
      .set("Cookie", "session=reader")
      .set("Origin", "http://localhost:3000");
  const token = await new SignJWT({
    email: "signed-reader@example.com",
    name: "Signed Reader",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "booknook-test-key" })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject("signed-reader-id")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(privateKey);

  try {
    await database.connectDatabase();

    const jwtApp = createApp();
    const jwtHistory = await request(jwtApp)
      .get("/borrows")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(jwtHistory.status, 200);
    const invalidJwt = await request(jwtApp)
      .get("/borrows")
      .set("Authorization", "Bearer invalid-token");
    assert.equal(invalidJwt.status, 401);

    const unauthenticatedCreate = await api
      .post("/books")
      .set("Origin", "http://localhost:3000")
      .send({});
    assert.equal(unauthenticatedCreate.status, 401);

    const invalidBook = await writeAsReader("post", "/books").send({
      title: "",
      author: "A. Writer",
      category: "Fiction",
      image: "javascript:alert(1)",
      description: "Test book",
      totalCopies: 1,
    });
    assert.equal(invalidBook.status, 400);

    const createdBook = await writeAsReader("post", "/books").send({
      title: "Test Book",
      author: "A. Writer",
      category: "Fiction",
      image: "https://example.com/book.jpg",
      description: "A test book",
      totalCopies: 2,
      addedByEmail: "attacker@example.com",
    });
    assert.equal(createdBook.status, 400);

    const bookResponse = await writeAsReader("post", "/books").send({
      title: "Test Book",
      author: "A. Writer",
      category: "Fiction",
      image: "https://example.com/book.jpg",
      description: "A test book",
      totalCopies: 2,
    });
    assert.equal(bookResponse.status, 201);
    assert.equal(bookResponse.body.availableCopies, 2);
    assert.equal(bookResponse.body.addedByEmail, reader.email);
    const bookId = bookResponse.body.id as string;

    const jwtBorrowResponse = await api
      .post("/borrows")
      .set("Authorization", `Bearer ${token}`)
      .set("Origin", "http://localhost:3000")
      .send({
        bookId,
        userEmail: "browser-supplied@example.com",
        returnDate: "2099-12-31T00:00:00.000Z",
      });
    assert.equal(jwtBorrowResponse.status, 201);
    assert.equal(jwtBorrowResponse.body.userEmail, "signed-reader@example.com");
    assert.equal(
      (
        await api
          .delete(`/borrows/${jwtBorrowResponse.body.id}`)
          .set("Authorization", `Bearer ${token}`)
          .set("Origin", "http://localhost:3000")
      ).status,
      204,
    );

    for (const path of ["/books", "/books/"]) {
      const list = await api.get(path);
      assert.equal(list.status, 200);
      assert.equal(list.body.length, 1);
    }

    const oneBook = await api.get(`/books/${bookId}`);
    assert.equal(oneBook.status, 200);
    assert.equal(oneBook.body.title, "Test Book");
    assert.equal((await api.get("/books/not-an-id")).status, 400);
    assert.equal((await api.get(`/books/${"0".repeat(24)}`)).status, 404);

    const invalidPatch = await writeAsReader("patch", `/books/${bookId}`).send({
      availableCopies: 50,
    });
    assert.equal(invalidPatch.status, 400);

    const updatedBook = await writeAsReader("patch", `/books/${bookId}`).send({
      title: "Updated Test Book",
      totalCopies: 2,
    });
    assert.equal(updatedBook.status, 200);
    assert.equal(updatedBook.body.title, "Updated Test Book");

    const invalidBorrow = await writeAsReader("post", "/borrows").send({
      bookId,
      returnDate: "not-a-date",
    });
    assert.equal(invalidBorrow.status, 400);

    const pastBorrow = await writeAsReader("post", "/borrows").send({
      bookId,
      returnDate: "2000-01-01",
    });
    assert.equal(pastBorrow.status, 400);

    const readerBorrowResponse = await writeAsReader("post", "/borrows").send({
      bookId,
      returnDate: "2099-12-31T00:00:00.000Z",
    });
    assert.equal(readerBorrowResponse.status, 201);
    assert.equal(readerBorrowResponse.body.userEmail, reader.email);
    assert.equal(readerBorrowResponse.body.bookTitle, "Updated Test Book");
    const readerBorrowId = readerBorrowResponse.body.id as string;
    assert.equal((await api.get(`/books/${bookId}`)).body.availableCopies, 1);

    const duplicateBorrow = await writeAsReader("post", "/borrows").send({
      bookId,
      returnDate: "2099-12-31T00:00:00.000Z",
    });
    assert.equal(duplicateBorrow.status, 409);

    const secondBorrowResponse = await api
      .post("/borrows")
      .set("Cookie", "session=second")
      .set("Origin", "http://localhost:3000")
      .send({ bookId, returnDate: "2099-12-31T00:00:00.000Z" });
    assert.equal(secondBorrowResponse.status, 201);
    const secondBorrowId = secondBorrowResponse.body.id as string;
    assert.equal((await api.get(`/books/${bookId}`)).body.availableCopies, 0);

    const noCopiesBorrow = await api
      .post("/borrows")
      .set("Cookie", "session=third")
      .set("Origin", "http://localhost:3000")
      .send({ bookId, returnDate: "2099-12-31T00:00:00.000Z" });
    assert.equal(noCopiesBorrow.status, 409);

    const scopedBorrows = await asReader("/borrows");
    assert.equal(scopedBorrows.status, 200);
    assert.equal(scopedBorrows.body.length, 1);
    assert.equal(scopedBorrows.body[0].userEmail, reader.email);
    assert.equal((await api.get("/borrows")).status, 401);

    const tooFewCopies = await writeAsReader("patch", `/books/${bookId}`).send({
      totalCopies: 1,
    });
    assert.equal(tooFewCopies.status, 409);

    const activeDelete = await writeAsReader("delete", `/books/${bookId}`);
    assert.equal(activeDelete.status, 409);

    const returnBook = await writeAsReader(
      "delete",
      `/borrows/${readerBorrowId}`,
    );
    assert.equal(returnBook.status, 204);
    assert.equal((await api.get(`/books/${bookId}`)).body.availableCopies, 1);
    const repeatReturn = await writeAsReader(
      "delete",
      `/borrows/${readerBorrowId}`,
    );
    assert.equal(repeatReturn.status, 409);
    assert.equal(
      (await writeAsReader("delete", `/borrows/${"0".repeat(24)}`)).status,
      404,
    );

    const unauthorizedEdit = await api
      .patch(`/books/${bookId}`)
      .set("Cookie", "session=second")
      .set("Origin", "http://localhost:3000")
      .send({ title: "Not allowed" });
    assert.equal(unauthorizedEdit.status, 404);

    const returnSecondCopy = await api
      .delete(`/borrows/${secondBorrowId}`)
      .set("Cookie", "session=second")
      .set("Origin", "http://localhost:3000");
    assert.equal(returnSecondCopy.status, 204);
    assert.equal((await api.get(`/books/${bookId}`)).body.availableCopies, 2);

    const unsafeOrigin = await api
      .delete(`/books/${bookId}`)
      .set("Cookie", "session=reader")
      .set("Origin", "https://attacker.example");
    assert.equal(unsafeOrigin.status, 403);

    const deletedBook = await writeAsReader("delete", `/books/${bookId}`);
    assert.equal(deletedBook.status, 204);
    assert.equal((await api.get(`/books/${bookId}`)).status, 404);
    assert.equal((await api.delete("/not-a-route")).status, 404);
  } finally {
    await database.disconnectDatabase();
    await replicaSet.stop();
    await new Promise<void>((resolve, reject) => {
      jwksServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
