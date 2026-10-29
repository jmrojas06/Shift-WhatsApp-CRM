"use client"

import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

interface ComboboxProps<Item> {
  /** Every option. Filtering happens here, in the browser. */
  items: Item[]
  /** The selected option, or null when nothing is chosen. */
  value: Item | null
  onValueChange: (item: Item | null) => void
  /** Stable id of an option; two options with the same key count as equal. */
  getItemKey: (item: Item) => string
  /** What the option is called: shown in the list and in the input. */
  getItemLabel: (item: Item) => string
  /** Optional second line under the label (a phone, an email...). */
  getItemDescription?: (item: Item) => string | null | undefined
  /**
   * Does `item` match what was typed? When omitted, Base UI's own check runs
   * on the label (case- and accent-insensitive).
   */
  filter?: (item: Item, query: string) => boolean
  /** Shown when nothing matches. The caller supplies it already translated. */
  emptyText: string
  /** Accessible name of the "open the list" button (already translated). */
  triggerLabel: string
  /** Accessible name of the "clear" button. Without it there is no clear button. */
  clearLabel?: string
  placeholder?: string
  /** Put the same id as the visible <Label htmlFor> so the label names the input. */
  id?: string
  /** Name for the input when there is no visible label. */
  "aria-label"?: string
  "aria-describedby"?: string
  /** Marks the field as having an error (red border + aria-invalid). */
  invalid?: boolean
  disabled?: boolean
  /** Classes for the box around the input (border, background, width). */
  className?: string
  /** Classes for the popup that opens under the input. */
  popupClassName?: string
}

/**
 * Select with a search box: type to narrow the list, arrows move, Enter
 * picks, Escape closes. Built on Base UI's Combobox, so the ARIA combobox /
 * listbox wiring and the focus handling inside a Dialog or Sheet come from it.
 * The value is the option itself; map it to an id in the caller.
 */
function Combobox<Item>({
  items,
  value,
  onValueChange,
  getItemKey,
  getItemLabel,
  getItemDescription,
  filter,
  emptyText,
  triggerLabel,
  clearLabel,
  placeholder,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  invalid,
  disabled,
  className,
  popupClassName,
}: ComboboxProps<Item>) {
  return (
    <ComboboxPrimitive.Root<Item>
      items={items}
      value={value}
      onValueChange={(next) => onValueChange(next)}
      itemToStringLabel={getItemLabel}
      isItemEqualToValue={(a, b) => getItemKey(a) === getItemKey(b)}
      filter={filter ? (item, query) => filter(item, query) : undefined}
      disabled={disabled}
    >
      <ComboboxPrimitive.InputGroup
        data-slot="combobox-input-group"
        className={cn(
          "relative flex h-10 w-full min-w-0 items-center rounded-lg border border-input bg-transparent transition-colors pointer-coarse:h-11 has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50 has-[input[aria-invalid=true]]:border-destructive has-[input[aria-invalid=true]]:ring-3 has-[input[aria-invalid=true]]:ring-destructive/20 has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-50 dark:bg-input/30 dark:has-[input[aria-invalid=true]]:border-destructive/50 dark:has-[input[aria-invalid=true]]:ring-destructive/40",
          className
        )}
      >
        <ComboboxPrimitive.Input
          data-slot="combobox-input"
          id={id}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          placeholder={placeholder}
          autoComplete="off"
          className="h-full min-w-0 flex-1 truncate rounded-lg border-0 bg-transparent pr-1 pl-3 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm"
        />
        {clearLabel && (
          <ComboboxPrimitive.Clear
            data-slot="combobox-clear"
            aria-label={clearLabel}
            tabIndex={-1}
            className="flex h-full w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground pointer-coarse:w-11 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon aria-hidden />
          </ComboboxPrimitive.Clear>
        )}
        <ComboboxPrimitive.Trigger
          data-slot="combobox-trigger"
          aria-label={triggerLabel}
          tabIndex={-1}
          className="flex h-full w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground pointer-coarse:w-11 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4"
        >
          <ChevronDownIcon aria-hidden />
        </ComboboxPrimitive.Trigger>
      </ComboboxPrimitive.InputGroup>

      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner sideOffset={4} className="isolate z-50 outline-none">
          <ComboboxPrimitive.Popup
            data-slot="combobox-content"
            className={cn(
              "w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              popupClassName
            )}
          >
            {/* Must stay mounted so screen readers hear the result changes;
                it only renders its text while the list is empty. */}
            <ComboboxPrimitive.Empty
              data-slot="combobox-empty"
              className="px-3 py-3 text-sm text-muted-foreground empty:p-0"
            >
              {emptyText}
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List
              data-slot="combobox-list"
              className="max-h-[min(18rem,var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain p-1 outline-0 data-empty:p-0"
            >
              {(item: Item) => {
                const description = getItemDescription?.(item)
                return (
                  <ComboboxPrimitive.Item
                    key={getItemKey(item)}
                    value={item}
                    data-slot="combobox-item"
                    className="group/item relative grid min-h-9 cursor-default grid-cols-[minmax(0,1fr)_1rem] items-center gap-2 rounded-md py-1.5 pr-2 pl-2.5 text-sm outline-hidden select-none pointer-coarse:min-h-11 data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{getItemLabel(item)}</span>
                      {description ? (
                        <span className="block truncate text-xs text-muted-foreground group-data-highlighted/item:text-accent-foreground">
                          {description}
                        </span>
                      ) : null}
                    </span>
                    <ComboboxPrimitive.ItemIndicator className="col-start-2 flex items-center justify-center">
                      <CheckIcon aria-hidden className="size-4" />
                    </ComboboxPrimitive.ItemIndicator>
                  </ComboboxPrimitive.Item>
                )
              }}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  )
}

export { Combobox }
export type { ComboboxProps }
