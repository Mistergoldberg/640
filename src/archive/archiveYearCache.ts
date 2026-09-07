export function requestIsCurrent(currentGeneration: number, requestGeneration: number, aborted = false) {
  return currentGeneration === requestGeneration && !aborted;
}
