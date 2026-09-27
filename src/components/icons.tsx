import type { SVGProps } from "react";
import Image from "next/image";
type Props = SVGProps<SVGSVGElement>;
export function Arrow(props: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      {...props}
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
export function ArrowUp(props: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      {...props}
    >
      <path d="M6 18 18 6M6 6h12v12" />
    </svg>
  );
}
export function ProductIcon({ kind, ...props }: Props & { kind: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
      {...props}
    >
      {kind === 0 ? (
        <>
          <rect x="4" y="4" width="8" height="8" rx="1" />
          <rect x="4" y="20" width="8" height="8" rx="1" />
          <path d="M12 8h7v16h-7m7-8h9" />
        </>
      ) : kind === 1 ? (
        <>
          <path d="m16 3 13 7v12l-13 7-13-7V10zM3 10l13 7 13-7M16 17v12" />
        </>
      ) : (
        <>
          <path d="m16 3 12 5v9c0 6-12 12-12 12S4 23 4 17V8z" />
          <path d="m10 16 4 4 8-9" />
        </>
      )}
    </svg>
  );
}
export function Brand() {
  return (
    <span className="brand">
      <Image
        className="brand-lion"
        src="/lion-logo.png"
        alt=""
        width={44}
        height={44}
        priority
      />
      <span>
        MAXIMUS<span className="brand-sub">VEGAS</span>
      </span>
    </span>
  );
}
