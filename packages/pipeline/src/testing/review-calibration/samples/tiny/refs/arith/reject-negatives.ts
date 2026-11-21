export function rejectNegatives(a: number, b: number): void {
  if (a < 0 || b < 0) throw new RangeError("negatives rejected");
}
