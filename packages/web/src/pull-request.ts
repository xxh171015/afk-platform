// A pull request closed on the host without being merged says so, instead of just "closed".
export const pullStateLabel = (state: string) =>
  state === "closed" ? "closed without merge" : state;
