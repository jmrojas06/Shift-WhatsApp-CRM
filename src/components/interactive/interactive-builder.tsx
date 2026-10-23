"use client";

import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { hasOptionContent } from "./option-content";
import { slugify } from "@/components/flows/shared";
import { getT } from "@/lib/i18n/translate";
import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/meta-api";
import {
  validateInteractivePayload,
  type InteractiveButtonsPayload,
  type InteractiveListPayload,
  type InteractiveMessagePayload,
} from "@/lib/whatsapp/interactive";
import { InteractivePreview } from "./interactive-preview";

// ------------------------------------------------------------
// Blank payload factories — used to seed a fresh builder and to
// switch kind without losing the shared body/header/footer.
// ------------------------------------------------------------

/**
 * Generate an id that doesn't collide with any already in use. A plain
 * count-based id (`btn_${length+1}`) regenerates an existing id after a
 * middle item is removed, which then trips the duplicate-id validator and
 * silently blocks sending. Increment past any taken id instead.
 */
function nextId(existing: string[], prefix: string): string {
  const taken = new Set(existing);
  let n = existing.length + 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function blankButtonsPayload(): InteractiveButtonsPayload {
  return {
    kind: "buttons",
    body: "",
    buttons: [{ id: "btn_1", title: "" }],
  };
}

export function blankListPayload(): InteractiveListPayload {
  return {
    kind: "list",
    body: "",
    button_label: getT("Interactive")("defaultListButton"),
    sections: [{ title: "", rows: [{ id: "row_1", title: "" }] }],
  };
}

interface InteractiveBuilderProps {
  value: InteractiveMessagePayload;
  onChange: (payload: InteractiveMessagePayload) => void;
  /** Show the live WhatsApp-style preview beside the form. Default true. */
  showPreview?: boolean;
}

/**
 * Controlled builder for a WhatsApp interactive message (reply buttons
 * or list). Enforces Meta's char limits inline (maxLength + counters)
 * and surfaces a single validation error via `validateInteractivePayload`
 * — the same check the server runs before sending. Shared by the inbox
 * composer, the automation Send node, and the quick-replies manager.
 */
export function InteractiveBuilder({
  value,
  onChange,
  showPreview = true,
}: InteractiveBuilderProps) {
  const t = useTranslations("Interactive");
  const [advanced, setAdvanced] = useState(false);
  // Kind the author asked to switch to while the current options hold
  // typed content; the switch waits for them to confirm.
  const [pendingKind, setPendingKind] = useState<"buttons" | "list" | null>(null);
  const validation = validateInteractivePayload(value);
  const advancedId = useId();

  const setField = (patch: Partial<InteractiveMessagePayload>) =>
    onChange({ ...value, ...patch } as InteractiveMessagePayload);

  const applyKind = (kind: "buttons" | "list") => {
    const shared = { body: value.body, header: value.header, footer: value.footer };
    onChange(
      kind === "buttons"
        ? { ...blankButtonsPayload(), ...shared }
        : { ...blankListPayload(), ...shared },
    );
  };

  const switchKind = (kind: "buttons" | "list") => {
    if (kind === value.kind) return;
    // Switching rebuilds the options from scratch; only ask when that
    // would throw away something the author typed.
    if (hasOptionContent(value)) {
      setPendingKind(kind);
      return;
    }
    applyKind(kind);
  };

  return (
    // Editor and preview sit side by side only when the SPACE WE WERE
    // GIVEN can hold both — a container query, not a viewport one. This
    // builder is embedded in places far narrower than the screen (an
    // automation step card, and a step nested in a condition branch is
    // narrower still); keying the split to `md:` meant a desktop
    // viewport forced a 280px preview column into a ~190px card and the
    // whole editor overflowed (issue #474).
    <div className="@container">
      <div className="flex flex-col gap-4 @2xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Kind toggle */}
          <div className="flex gap-2" role="group" aria-label={t("messageType")}>
            <KindButton
              active={value.kind === "buttons"}
              label={t("replyButtons")}
              onClick={() => switchKind("buttons")}
            />
            <KindButton
              active={value.kind === "list"}
              label={t("list")}
              onClick={() => switchKind("list")}
            />
          </div>

          <Field label={t("body")} counter={`${value.body.length}/${INTERACTIVE_LIMITS.bodyMaxLength}`}>
            {(id) => (
            <Textarea
              id={id}
              value={value.body}
              maxLength={INTERACTIVE_LIMITS.bodyMaxLength}
              onChange={(e) => setField({ body: e.target.value })}
              placeholder={t("bodyPlaceholder")}
              className="min-h-20 bg-muted text-foreground"
            />
            )}
          </Field>

          <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
            <Field
              label={t("header")}
              counter={`${(value.header ?? "").length}/${INTERACTIVE_LIMITS.headerTextMaxLength}`}
            >
              {(id) => (
              <Input
                id={id}
                value={value.header ?? ""}
                maxLength={INTERACTIVE_LIMITS.headerTextMaxLength}
                onChange={(e) => setField({ header: e.target.value })}
                className="bg-muted text-foreground"
              />
              )}
            </Field>
            <Field
              label={t("footer")}
              counter={`${(value.footer ?? "").length}/${INTERACTIVE_LIMITS.footerMaxLength}`}
            >
              {(id) => (
              <Input
                id={id}
                value={value.footer ?? ""}
                maxLength={INTERACTIVE_LIMITS.footerMaxLength}
                onChange={(e) => setField({ footer: e.target.value })}
                className="bg-muted text-foreground"
              />
              )}
            </Field>
          </div>

          {value.kind === "buttons" ? (
            <ButtonsEditor value={value} onChange={onChange} advanced={advanced} />
          ) : (
            <ListEditor value={value} onChange={onChange} advanced={advanced} />
          )}

          {/* The label row is the 44px touch target; the box itself is 16px. */}
          <label
            htmlFor={advancedId}
            className="flex min-h-11 cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground hover:text-foreground"
          >
            <input
              id={advancedId}
              type="checkbox"
              checked={advanced}
              onChange={(e) => setAdvanced(e.target.checked)}
              className="size-4 shrink-0 accent-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            />
            {t("showIds")}
          </label>

          {/* Always mounted so screen readers announce a new error. */}
          <p aria-live="polite" className="text-xs text-destructive empty:hidden">
            {validation.ok ? null : validation.error}
          </p>
        </div>

        {showPreview && (
          <div className="flex shrink-0 flex-col gap-1.5 @2xl:w-[280px]">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("preview")}
            </span>
            <div className="rounded-lg bg-muted/40 p-3">
              <InteractivePreview
                payload={value}
                labels={{
                  body: t("previewBody"),
                  button: t("previewButton"),
                  menu: t("previewMenu"),
                }}
              />
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={pendingKind !== null}
        onOpenChange={(open) => {
          if (!open) setPendingKind(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("switchKindTitle")}</DialogTitle>
            <DialogDescription>
              {value.kind === "buttons"
                ? t("switchKindBodyButtons")
                : t("switchKindBodyList")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingKind(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingKind) applyKind(pendingKind);
                setPendingKind(null);
              }}
            >
              {t("switchKindConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------
// Buttons editor
// ------------------------------------------------------------

function ButtonsEditor({
  value,
  onChange,
  advanced,
}: {
  value: InteractiveButtonsPayload;
  onChange: (p: InteractiveMessagePayload) => void;
  advanced: boolean;
}) {
  const t = useTranslations("Interactive");
  const buttons = value.buttons;
  const update = (idx: number, patch: Partial<InteractiveButtonsPayload["buttons"][number]>) =>
    onChange({
      ...value,
      buttons: buttons.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  const add = () =>
    onChange({
      ...value,
      buttons: [
        ...buttons,
        { id: nextId(buttons.map((b) => b.id), "btn_"), title: "" },
      ],
    });
  const remove = (idx: number) =>
    onChange({ ...value, buttons: buttons.filter((_, i) => i !== idx) });

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground tabular-nums">
        {t("buttonsCount", { count: buttons.length, max: INTERACTIVE_LIMITS.maxButtons })}
      </p>
      <div className="flex flex-col gap-2">
        {buttons.map((b, i) => (
          <div
            key={i}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 p-2"
          >
            {advanced && (
              <Input
                value={b.id}
                onChange={(e) => update(i, { id: slugify(e.target.value, `btn_${i + 1}`) })}
                placeholder={t("idPlaceholder")}
                aria-label={t("buttonIdAria", { n: i + 1 })}
                className="w-28 bg-muted font-mono md:text-xs"
              />
            )}
            <Input
              value={b.title}
              maxLength={INTERACTIVE_LIMITS.buttonTitleMaxLength}
              onChange={(e) => update(i, { title: e.target.value })}
              placeholder={t("buttonLabelPlaceholder")}
              aria-label={t("buttonTitleAria", { n: i + 1 })}
              className="min-w-32 flex-1 bg-muted"
            />
            <span className="w-10 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
              {b.title.length}/{INTERACTIVE_LIMITS.buttonTitleMaxLength}
            </span>
            {buttons.length > 1 && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => remove(i)}
                aria-label={t("removeButton", { n: i + 1 })}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
        ))}
      </div>
      {buttons.length < INTERACTIVE_LIMITS.maxButtons && (
        <Button variant="ghost" size="sm" onClick={add} className="mt-2">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("addButton")}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// List editor
// ------------------------------------------------------------

function ListEditor({
  value,
  onChange,
  advanced,
}: {
  value: InteractiveListPayload;
  onChange: (p: InteractiveMessagePayload) => void;
  advanced: boolean;
}) {
  const t = useTranslations("Interactive");
  const sections = value.sections;
  const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
  const allRowIds = () => sections.flatMap((s) => s.rows.map((r) => r.id));

  const updateSection = (sIdx: number, patch: Partial<InteractiveListPayload["sections"][number]>) =>
    onChange({
      ...value,
      sections: sections.map((s, i) => (i === sIdx ? { ...s, ...patch } : s)),
    });
  const updateRow = (
    sIdx: number,
    rIdx: number,
    patch: Partial<InteractiveListPayload["sections"][number]["rows"][number]>,
  ) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx
          ? { ...s, rows: s.rows.map((r, j) => (j === rIdx ? { ...r, ...patch } : r)) }
          : s,
      ),
    });
  const addRow = (sIdx: number) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx
          ? { ...s, rows: [...s.rows, { id: nextId(allRowIds(), "row_"), title: "" }] }
          : s,
      ),
    });
  const removeRow = (sIdx: number, rIdx: number) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, rows: s.rows.filter((_, j) => j !== rIdx) } : s,
      ),
    });
  const addSection = () =>
    onChange({
      ...value,
      sections: [
        ...sections,
        { title: "", rows: [{ id: nextId(allRowIds(), "row_"), title: "" }] },
      ],
    });
  const removeSection = (sIdx: number) =>
    onChange({ ...value, sections: sections.filter((_, i) => i !== sIdx) });

  return (
    <div className="flex flex-col gap-3">
      <Field label={t("listButtonLabel")} counter={`${value.button_label.length}/${INTERACTIVE_LIMITS.buttonTitleMaxLength}`}>
        {(id) => (
        <Input
          id={id}
          value={value.button_label}
          maxLength={INTERACTIVE_LIMITS.buttonTitleMaxLength}
          onChange={(e) => onChange({ ...value, button_label: e.target.value })}
          className="bg-muted text-foreground"
        />
        )}
      </Field>

      <p className="text-xs text-muted-foreground tabular-nums">
        {t("rowsCount", { count: totalRows, max: INTERACTIVE_LIMITS.maxListRowsTotal })}
      </p>

      {sections.map((section, sIdx) => (
        <div key={sIdx} className="rounded-md border border-border bg-muted/40 p-2">
          <div className="mb-2 flex items-center gap-2">
            <Input
              value={section.title ?? ""}
              onChange={(e) => updateSection(sIdx, { title: e.target.value })}
              placeholder={t("sectionTitlePlaceholder")}
              aria-label={t("sectionTitleAria", { n: sIdx + 1 })}
              className="flex-1 bg-muted md:text-xs"
            />
            {sections.length > 1 && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => removeSection(sIdx)}
                aria-label={t("removeSection", { n: sIdx + 1 })}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {section.rows.map((row, rIdx) => (
              <div key={rIdx} className="rounded border border-border bg-card p-2">
                <div className="flex flex-wrap items-center gap-2">
                  {advanced && (
                    <Input
                      value={row.id}
                      onChange={(e) =>
                        updateRow(sIdx, rIdx, { id: slugify(e.target.value, `row_${rIdx + 1}`) })
                      }
                      placeholder={t("idPlaceholder")}
                      aria-label={t("rowIdAria", { n: rIdx + 1 })}
                      className="w-24 bg-muted font-mono md:text-xs"
                    />
                  )}
                  <Input
                    value={row.title}
                    maxLength={INTERACTIVE_LIMITS.listRowTitleMaxLength}
                    onChange={(e) => updateRow(sIdx, rIdx, { title: e.target.value })}
                    placeholder={t("rowTitlePlaceholder")}
                    aria-label={t("rowTitleAria", { n: rIdx + 1 })}
                    className="min-w-32 flex-1 bg-muted"
                  />
                  <span className="w-10 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                    {row.title.length}/{INTERACTIVE_LIMITS.listRowTitleMaxLength}
                  </span>
                  {totalRows > 1 && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeRow(sIdx, rIdx)}
                      aria-label={t("removeRow", { n: rIdx + 1 })}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                </div>
                <Input
                  value={row.description ?? ""}
                  maxLength={INTERACTIVE_LIMITS.listRowDescriptionMaxLength}
                  onChange={(e) => updateRow(sIdx, rIdx, { description: e.target.value })}
                  placeholder={t("rowDescriptionPlaceholder")}
                  aria-label={t("rowDescriptionAria", { n: rIdx + 1 })}
                  className="mt-2 bg-muted md:text-xs"
                />
              </div>
            ))}
          </div>
          {totalRows < INTERACTIVE_LIMITS.maxListRowsTotal && (
            <Button variant="ghost" size="sm" onClick={() => addRow(sIdx)} className="mt-2">
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("addRow")}
            </Button>
          )}
        </div>
      ))}

      {sections.length < INTERACTIVE_LIMITS.maxListSections &&
        totalRows < INTERACTIVE_LIMITS.maxListRowsTotal && (
          <Button variant="ghost" size="sm" onClick={addSection}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("addSection")}
          </Button>
        )}
    </div>
  );
}

// ------------------------------------------------------------
// Small presentational helpers
// ------------------------------------------------------------

function KindButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors pointer-coarse:min-h-11 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/** Labelled field. The control is rendered by `children(id)` so the
 *  label can point at it with `htmlFor`. */
function Field({
  label,
  counter,
  children,
}: {
  label: string;
  counter?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
        {counter && (
          <span className="text-[11px] text-muted-foreground tabular-nums">{counter}</span>
        )}
      </div>
      {children(id)}
    </div>
  );
}
