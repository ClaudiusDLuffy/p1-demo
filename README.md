This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

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

## Publish contractor estimate templates

Heatcraft and Carrier workbooks are stored in the private Supabase bucket, not
in `public/` or Git. Apply
`supabase/migrations/0102_private_contractor_estimate_templates.sql`, then run:

```bash
npm run publish:contractor-templates -- \
  --heatcraft "/path/to/Heatcraft Selector Model.xlsx" \
  --carrier "/path/to/Carrier Survey.xlsx"
```

The publisher reads `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` (or
`SUPABASE_SERVICE_ROLE_KEY`) from `.env.local`. Add `--dry-run` to validate the
files without uploading them. After publishing, run
`supabase/audits/0102_contractor_estimate_template_verification.sql`; every
column, including `all_checks_pass`, must return `true`.
