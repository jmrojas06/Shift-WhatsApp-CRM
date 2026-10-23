"use client";

import { useEffect, useId, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import type { Pipeline, PipelineStage } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Trash2,
  Plus,
  GripVertical,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

const STAGE_COLORS = [
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f43f5e",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
];

// i18n key (under `Pipelines.settings.colorNames`) for each preset color, so
// screen readers hear "Azul" instead of "#3b82f6". Stage colors saved outside
// this list fall back to their hex value.
const STAGE_COLOR_NAMES: Record<string, string> = {
  "#3b82f6": "blue",
  "#6366f1": "indigo",
  "#8b5cf6": "violet",
  "#ec4899": "pink",
  "#f43f5e": "red",
  "#f97316": "orange",
  "#eab308": "yellow",
  "#22c55e": "green",
  "#14b8a6": "teal",
  "#06b6d4": "cyan",
};

interface PipelineSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipeline: Pipeline;
  stages: PipelineStage[];
  onPipelinesChanged: () => void;
  onStagesChanged: () => void;
  onCreateNewPipeline: () => void;
}

export function PipelineSettings({
  open,
  onOpenChange,
  pipeline,
  stages,
  onPipelinesChanged,
  onStagesChanged,
  onCreateNewPipeline,
}: PipelineSettingsProps) {
  const t = useTranslations("Pipelines.settings");
  const supabase = createClient();

  const [name, setName] = useState(pipeline.name);
  const [localStages, setLocalStages] = useState<PipelineStage[]>(stages);
  const [newStageName, setNewStageName] = useState("");
  const [newStageColor, setNewStageColor] = useState(STAGE_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Stage waiting for the user to confirm its deletion.
  const [stageToDelete, setStageToDelete] = useState<PipelineStage | null>(
    null,
  );
  const fieldId = useId();

  const colorName = (hex: string) => {
    const key = STAGE_COLOR_NAMES[hex.toLowerCase()];
    return key ? t(`colorNames.${key}`) : hex;
  };

  // Reset form state when the dialog opens or its prop inputs change
  // — legitimate prop-driven sync.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setName(pipeline.name);
    setLocalStages([...stages].sort((a, b) => a.position - b.position));
    setShowDeleteConfirm(false);
  }, [open, pipeline, stages]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Space/Enter on the grip picks a stage up, arrows move it, Space/Enter
    // drops it and Escape cancels.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // dnd-kit's default announcements are in English and read the stage UUID;
  // these read the stage name and its position in the app's language.
  const stageLabel = (id: UniqueIdentifier) =>
    localStages.find((s) => s.id === id)?.name ?? "";
  const stagePosition = (id: UniqueIdentifier) =>
    localStages.findIndex((s) => s.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t("dragAnnounceStart", { name: stageLabel(active.id) }),
    onDragOver: ({ active, over }) =>
      over
        ? t("dragAnnounceOver", {
            name: stageLabel(active.id),
            position: stagePosition(over.id),
            total: localStages.length,
          })
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? t("dragAnnounceEnd", {
            name: stageLabel(active.id),
            position: stagePosition(over.id),
            total: localStages.length,
          })
        : t("dragAnnounceCancel", { name: stageLabel(active.id) }),
    onDragCancel: ({ active }) =>
      t("dragAnnounceCancel", { name: stageLabel(active.id) }),
  };

  function handleReorder(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localStages.findIndex((s) => s.id === active.id);
    const newIndex = localStages.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setLocalStages(arrayMove(localStages, oldIndex, newIndex));
  }

  async function handleSave() {
    setSaving(true);

    // One upsert for all stages — batches N stage writes into a single
    // round-trip. Previous implementation did N sequential UPDATEs which
    // latency-scaled linearly with stage count.
    const stageRows = localStages.map((s, i) => ({
      id: s.id,
      pipeline_id: s.pipeline_id,
      name: s.name,
      color: s.color,
      position: i,
    }));

    const [renameRes, stagesRes] = await Promise.all([
      supabase
        .from("pipelines")
        .update({ name: name.trim() })
        .eq("id", pipeline.id),
      supabase.from("pipeline_stages").upsert(stageRows, { onConflict: "id" }),
    ]);

    setSaving(false);

    if (renameRes.error || stagesRes.error) {
      toast.error(t("toastFailedSave"));
      return;
    }

    onOpenChange(false);
    onPipelinesChanged();
    onStagesChanged();
    toast.success(t("toastSaved"));
  }

  async function handleAddStage() {
    const trimmed = newStageName.trim();
    if (!trimmed) return;
    const { data, error } = await supabase
      .from("pipeline_stages")
      .insert({
        pipeline_id: pipeline.id,
        name: trimmed,
        color: newStageColor,
        position: localStages.length,
      })
      .select()
      .single();
    if (error || !data) {
      toast.error(t("toastFailedAddStage"));
      return;
    }
    setLocalStages([...localStages, data as PipelineStage]);
    setNewStageName("");
    setNewStageColor(STAGE_COLORS[(localStages.length + 1) % STAGE_COLORS.length]);
  }

  async function handleRemoveStage(stageId: string) {
    // Refuse to delete if deals still reference the stage (FK would fail).
    const { count } = await supabase
      .from("deals")
      .select("id", { count: "exact", head: true })
      .eq("stage_id", stageId);
    if (count && count > 0) {
      toast.error(t("toastMoveOrDeleteDeals"));
      return;
    }
    const { error } = await supabase
      .from("pipeline_stages")
      .delete()
      .eq("id", stageId);
    if (error) {
      toast.error(t("toastFailedDeleteStage"));
      return;
    }
    setLocalStages(localStages.filter((s) => s.id !== stageId));
  }

  async function handleDeletePipeline() {
    setDeleting(true);
    // ON DELETE CASCADE handles deals + stages.
    const { error } = await supabase
      .from("pipelines")
      .delete()
      .eq("id", pipeline.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDeletePipeline"));
      return;
    }
    onOpenChange(false);
    onPipelinesChanged();
    toast.success(t("toastDeleted"));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-popover border-border max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("managePipeline")}</DialogTitle>
        </DialogHeader>

        {showDeleteConfirm ? (
          <div className="py-4">
            <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
              <AlertTriangle aria-hidden className="size-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-medium text-destructive">
                  {t("deletePipeline")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("deletePipelineDesc")}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                className="border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeletePipeline}
                disabled={deleting}
              >
                {deleting ? t("deleting") : t("deletePipelineBtn")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor={`${fieldId}-name`} className="text-muted-foreground">
                  {t("pipelineName")}
                </Label>
                <Input
                  id={`${fieldId}-name`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>

              <div className="grid gap-2">
                <h3
                  id={`${fieldId}-stages`}
                  className="text-sm leading-none font-medium text-muted-foreground"
                >
                  {t("stages")}
                </h3>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleReorder}
                  accessibility={{
                    announcements,
                    screenReaderInstructions: {
                      draggable: t("dragInstructions"),
                    },
                  }}
                >
                  <SortableContext
                    items={localStages.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div
                      role="list"
                      aria-labelledby={`${fieldId}-stages`}
                      className="space-y-2"
                    >
                      {localStages.map((stage, index) => (
                        <SortableStageRow
                          key={stage.id}
                          stage={stage}
                          position={index + 1}
                          colorName={colorName}
                          onNameChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], name: v };
                            setLocalStages(updated);
                          }}
                          onColorChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], color: v };
                            setLocalStages(updated);
                          }}
                          onRemove={() => setStageToDelete(stage)}
                          colors={STAGE_COLORS}
                          t={t}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                {/* Add new stage */}
                <div
                  role="group"
                  aria-label={t("newStageColor")}
                  className="mt-1 flex flex-wrap gap-1"
                >
                  {STAGE_COLORS.map((color) => (
                    <SwatchButton
                      key={color}
                      color={color}
                      selected={newStageColor === color}
                      label={t("pickColor", { color: colorName(color) })}
                      onClick={() => setNewStageColor(color)}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`${fieldId}-new-stage`} className="sr-only">
                    {t("newStageNameLabel")}
                  </Label>
                  <Input
                    id={`${fieldId}-new-stage`}
                    value={newStageName}
                    onChange={(e) => setNewStageName(e.target.value)}
                    placeholder={t("newStageNamePlaceholder")}
                    className="border-border bg-muted text-foreground"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddStage();
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddStage}
                    disabled={!newStageName.trim()}
                    className="shrink-0 border-border bg-transparent text-muted-foreground hover:bg-muted"
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    {t("add")}
                  </Button>
                </div>
              </div>

              <Button
                variant="outline"
                onClick={onCreateNewPipeline}
                className="w-full border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                <Plus className="mr-1 h-3 w-3" />
                {t("createNewPipeline")}
              </Button>
            </div>

            <DialogFooter className="border-border bg-popover/50">
              <Button
                variant="destructive"
                onClick={() => setShowDeleteConfirm(true)}
                className="mr-auto"
              >
                {t("deletePipeline")}
              </Button>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !name.trim()}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? t("saving") : t("saveChanges")}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Nested confirmation before deleting a stage. The delete runs
            right away (it doesn't wait for "Guardar cambios"). */}
        <Dialog
          open={stageToDelete !== null}
          onOpenChange={(next) => {
            if (!next) setStageToDelete(null);
          }}
        >
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {t("deleteStageTitle", { name: stageToDelete?.name ?? "" })}
              </DialogTitle>
              <DialogDescription>{t("deleteStageDesc")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStageToDelete(null)}>
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const target = stageToDelete;
                  setStageToDelete(null);
                  if (target) void handleRemoveStage(target.id);
                }}
              >
                {t("deleteStageBtn")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

/** A 32px color swatch (44px on touch) with a visible focus ring. */
function SwatchButton({
  color,
  selected,
  label,
  onClick,
}: {
  color: string;
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      className="inline-flex size-8 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:size-11"
    >
      <span
        aria-hidden="true"
        className="size-8 rounded-full border-2 transition-transform hover:scale-110"
        style={{
          backgroundColor: color,
          borderColor: selected ? "var(--foreground)" : "transparent",
        }}
      />
    </button>
  );
}

function SortableStageRow({
  stage,
  position,
  colorName,
  onNameChange,
  onColorChange,
  onRemove,
  colors,
  t,
}: {
  stage: PipelineStage;
  position: number;
  colorName: (hex: string) => string;
  onNameChange: (v: string) => void;
  onColorChange: (v: string) => void;
  onRemove: () => void;
  colors: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: stage.id,
      attributes: { roleDescription: t("sortableRoleDescription") },
    });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="listitem"
      className="flex items-center gap-2 rounded-lg border border-border bg-muted p-2"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="inline-flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing pointer-coarse:size-11"
        aria-label={t("dragStage", { name: stage.name })}
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <ColorSwatch
        value={stage.color}
        onChange={onColorChange}
        colors={colors}
        colorName={colorName}
        stageName={stage.name}
        t={t}
      />
      <Input
        value={stage.name}
        onChange={(e) => onNameChange(e.target.value)}
        aria-label={t("stageNameLabel", { position })}
        className="min-w-0 flex-1 border-transparent bg-transparent text-foreground focus-visible:border-border"
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label={t("removeStage", { name: stage.name })}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

function ColorSwatch({
  value,
  onChange,
  colors,
  colorName,
  stageName,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  colors: string[];
  colorName: (hex: string) => string;
  stageName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  // Base UI's Popover gives us Escape to close, focus returned to the
  // trigger, aria-expanded on the trigger and a nested-dismiss that doesn't
  // also close the surrounding settings dialog.
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:size-11"
        aria-label={t("changeStageColor", {
          name: stageName,
          color: colorName(value),
        })}
      >
        <span
          aria-hidden="true"
          className="size-6 rounded-full border border-border"
          style={{ backgroundColor: value }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-auto grid-cols-5 gap-1 p-2">
        {colors.map((c) => (
          <SwatchButton
            key={c}
            color={c}
            selected={c === value}
            label={t("pickColor", { color: colorName(c) })}
            onClick={() => {
              onChange(c);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
