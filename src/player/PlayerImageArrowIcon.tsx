import { ArrowLeft, ArrowRight } from "lucide-react";

export function PlayerImageArrowIcon({
  direction,
  className = ""
}: {
  direction: -1 | 1;
  className?: string;
}) {
  return (
    <span className={`player-image-arrow-icon${className ? ` ${className}` : ""}`}>
      {direction < 0
        ? <ArrowLeft aria-hidden="true" size={21} strokeWidth={2} />
        : <ArrowRight aria-hidden="true" size={21} strokeWidth={2} />}
    </span>
  );
}
