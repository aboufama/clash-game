// Vercel discovers functions before the build command runs. Keep this stable
// entrypoint committed; build:vercel-api refreshes the bundled authority it
// imports on every deployment. vercel.json rewrites nested /api paths here.
export { default } from '../dist-server/vercel.mjs'
