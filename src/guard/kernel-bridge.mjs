// Tiny indirection so guard modules can call back into reviewDiff without
// importing src/kernel.mjs directly (which would create a circular import:
// kernel.mjs → guard/index.mjs → guard/pre-commit.mjs → kernel.mjs).
// Lazy-load on first call instead.

async function reviewDiff(input) {
  const mod = await import("../review/index.mjs");
  return mod.reviewDiff(input);
}

export { reviewDiff };
