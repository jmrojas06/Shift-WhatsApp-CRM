'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Loader2, FileText, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-primary/10 text-primary border-primary/20',
  Utility: 'bg-info/10 text-info border-info/20',
  Authentication: 'bg-warning/10 text-warning border-warning/20',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({ selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const supabase = createClient();
        // Only APPROVED templates can be sent via Meta — anything else
        // would 400 at broadcast time. Hide them rather than letting
        // the user pick a template that will fail.
        const { data, error: fetchError } = await supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;
        setTemplates(data ?? []);
      } catch {
        // Friendly, actionable copy instead of the raw database message.
        setError(t('chooseTemplate.errorLoad'));
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        <span className="sr-only">{t('chooseTemplate.loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('chooseTemplate.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('chooseTemplate.subtitle')}
        </p>
      </div>

      {templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
          <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
            <FileText className="size-6 text-muted-foreground" aria-hidden="true" />
          </span>
          <p className="text-sm text-muted-foreground">{t('chooseTemplate.noTemplates')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('chooseTemplate.createFirst')}</p>
          <Link
            href="/settings?tab=templates"
            className={`${buttonVariants({ variant: 'outline' })} mt-4`}
          >
            {t('chooseTemplate.goToTemplates')}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;

            return (
              <button
                key={template.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(template)}
                className={`flex min-w-0 flex-col gap-3 rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card hover:border-input hover:bg-muted/40'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 text-sm font-medium break-words text-foreground">{template.name}</h3>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{template.body_text}</p>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{template.language ?? 'en_US'}</span>
                  {/* Status is omitted on purpose — every template
                      shown here is already filtered to APPROVED,
                      so the chip carried no information. */}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
