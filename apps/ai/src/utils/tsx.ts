/**
 * The loader that runs the TypeScript sign-in helpers.
 *
 * It has to be resolved here, inside the service: the helper runs with the provider's home as its
 * working directory, and from there the package "tsx" cannot be found. An absolute file URL keeps
 * the helper working no matter which directory it starts from.
 */
export const tsxLoaderUrl = import.meta.resolve("tsx");
