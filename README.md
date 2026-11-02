# BookNook API

Standalone Express.js API for the BookNook client. The service uses MongoDB
transactions for book inventory changes and validates Better Auth sessions
against the same MongoDB database as the identity provider.

## Setup

1. Create a local `.env` file and set `MONGODB_URI`, `MONGODB_DB`,
   `BETTER_AUTH_JWKS_URL`, `BETTER_AUTH_ISSUER`, `BETTER_AUTH_AUDIENCE`, and
   `FRONTEND_ORIGIN`. `PORT` defaults to `4000`; `NODE_ENV` defaults to
   `development`.
2. Configure the client/Better Auth application to use the same MongoDB
   database. Set `BETTER_AUTH_JWKS_URL` to its JWKS endpoint and set
   `BETTER_AUTH_ISSUER` and `BETTER_AUTH_AUDIENCE` to match its auth URL
   (`BETTER_AUTH_URL` in the client). `FRONTEND_ORIGIN` must exactly match the
   browser application's origin.
3. Allow the API server's network address in the MongoDB Atlas network access
   list and use a database user with only the permissions this application
   needs. Keep `.env` private.
4. Run `npm install`, `npm run dev`, and `npm test` from this folder.

MongoDB transactions require a replica set; MongoDB Atlas supports this. The
test suite runs against an ephemeral single-node replica set.

## Deploy to Vercel

Import this folder as its own Vercel project and keep the Root Directory set to
the server project. Vercel serves the API as serverless functions; do not deploy
the local `.env` file. Add these variables in the Vercel project settings:

- `MONGODB_URI` and `MONGODB_DB`
- `BETTER_AUTH_JWKS_URL` — the client URL plus `/api/auth/jwks`
- `BETTER_AUTH_ISSUER` and `BETTER_AUTH_AUDIENCE` — the client's
  `BETTER_AUTH_URL`
- `FRONTEND_ORIGIN` — the deployed client origin, without a trailing slash
- `NODE_ENV` — `production`

Deploy the client first to obtain its Vercel URL, set that URL in the API
variables, then redeploy the API. Set the API's Vercel URL as the client's
`NEXT_PUBLIC_API_URL` before deploying or redeploying the client. MongoDB Atlas
must allow connections from Vercel.

## Push as a separate GitHub repository

Create a separate empty GitHub repository for this API, then add it as the
remote and push the `main` branch:

```bash
git remote add origin https://github.com/<YOUR_USERNAME>/book_nook_server.git
git add .
git commit -m "Prepare BookNook API"
git branch -M main
git push -u origin main
```

The `.env` file and installed dependencies are ignored by Git. Never commit
real credentials.

## Routes

| Method | Route | Access | Result |
|---|---|---|---|
| GET | `/books` or `/books/` | Public | List books |
| GET | `/books/:id` | Public | Get one book |
| POST | `/books` | Signed-in user | Add a book |
| PATCH | `/books/:id` | Book owner | Update book fields or total copies |
| DELETE | `/books/:id` | Book owner | Delete only when no active borrows exist |
| POST | `/borrows` | Signed-in user | Borrow an available book |
| GET | `/borrows` | Signed-in user | List only the caller's borrow history |
| DELETE | `/borrows/:id` | Borrower | Return an active borrow |

Book creation accepts `title`, `author`, `category`, `image`, `description`,
and `totalCopies`. The API initializes `availableCopies` to `totalCopies` and
derives `addedByName` and `addedByEmail` from the authenticated session.
Borrow creation accepts `bookId` and a future `returnDate`; the API sets
`bookTitle`, `bookImage`, `userEmail`, and `borrowDate` itself. A `204` response
means a borrow was returned or a book was deleted.

## Inventory and authorization

- Borrow creation runs in a transaction, atomically decrements inventory with
  `$inc`, and enforces a unique active-borrow key per user and book.
- Return transactions mark the borrow returned exactly once and increment the
  book's available count exactly once.
- Book deletion checks active borrows inside a transaction. Copy-count edits
  preserve the number of copies already on loan.
- Book creation, edits, and deletion require authentication; users can edit
  and delete only books they added. Borrow history and returns are scoped to
  the authenticated email.
- Mutating requests must come from the configured frontend origin. CORS allows
  only that origin and uses credentials for Better Auth session cookies.
- Validation errors return `400`, missing resources `404`, unauthenticated
  requests `401`, and inventory/duplicate conflicts `409`.
