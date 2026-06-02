# bam-blog-demo

A two-page static blog that demonstrates the [`bam-comments`](../../packages/bam-comments) widget. Each post embeds comments with a single `<script>` tag — exactly what an external site would write.

## How it works

1. Each HTML page includes a `<div data-bam-comments data-post-id="…" data-site-id="…">` element and a `<script src="/widget.js" defer>` tag.
2. The widget self-initialises: it reads the `data-*` attributes, connects to the configured Poster and Reader, and renders the comment feed inline.
3. Visitors connect their wallet, write a comment, and sign it. The widget submits to the Poster; confirmed comments appear once the Reader picks them up from the blob.

## Run

```bash
# from workspace root
pnpm --filter bam-sdk build
pnpm --filter bam-comments build
pnpm --filter bam-blog-demo dev
# → http://localhost:5173
```

## Build

The build step bundles `bam-comments` into `public/widget.js` so the static pages can reference it without a CDN.

```bash
pnpm --filter bam-blog-demo build   # output → dist/
```

## Tests

```bash
pnpm --filter bam-blog-demo test:run
```

## Live

https://comments.bamstack.eth.limo

## License

MIT
