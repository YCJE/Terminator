import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full resize-none rounded-xl border border-[var(--hairline)] bg-[var(--surface-2)] px-3 py-3 text-base transition-colors outline-none placeholder:text-[var(--fg-subtle)] focus-visible:border-[var(--focus-ring)] focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_oklch,var(--focus-ring)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
