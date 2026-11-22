export function publicFlagEnabled(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}
