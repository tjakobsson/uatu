/** Read on every coordinated frame so preference changes also finish live motion. */
export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function scrollFollowMotion(): "smooth" | "instant" {
  return reducedMotion() ? "instant" : "smooth";
}
