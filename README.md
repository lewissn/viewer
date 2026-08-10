This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Order folder import

`/admin/projects/import` builds a customer assembly guide from a whole order
folder (or a zip of one) in a single step. A cabinet is detected as a model file
plus a CSV sharing its name, with textures from a folder of the same name —
`TDB LHS.3ds` + `TDB LHS.CSV` + `TDB LHS/`. Everything else in the folder (the
whole-project model, `.pb-proj`, PDFs) is skipped and listed with a reason.

Setup, once per environment:

1. Run `supabase/migrations/002_project_files_storage.sql` to create the
   public `project-files` storage bucket.
2. Set `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the browser uploads models straight to
   Storage using signed tokens minted by `/api/projects/storage/sign-upload`,
   which keeps large `.3ds` files clear of the serverless request size limit.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
