// Vercel discovers functions before the build command runs. Keep this stable
// entrypoint committed; build:vercel-api refreshes the bundled authority it
// imports on every deployment.
export { default } from '../dist-server/vercel.mjs'
