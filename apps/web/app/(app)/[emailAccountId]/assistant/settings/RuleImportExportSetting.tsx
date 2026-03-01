"use client";

import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { DownloadIcon, UploadIcon } from "lucide-react";
import { stringify, parse } from "yaml";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemActions,
  ItemSeparator,
} from "@/components/ui/item";
import { toastError } from "@/components/Toast";
import { useRules } from "@/hooks/useRules";
import { importRulesAction } from "@/utils/actions/rule";

export function RuleImportExportSetting({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  const { data, mutate } = useRules(emailAccountId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const buildExportData = useCallback(() => {
    if (!data) return null;
    return data.map((rule) => ({
      name: rule.name,
      instructions: rule.instructions,
      enabled: rule.enabled,
      automate: rule.automate,
      runOnThreads: rule.runOnThreads,
      systemType: rule.systemType,
      conditionalOperator: rule.conditionalOperator,
      from: rule.from,
      to: rule.to,
      subject: rule.subject,
      body: rule.body,
      categoryFilterType: rule.categoryFilterType,
      actions: rule.actions.map((action) => ({
        type: action.type,
        label: action.label,
        to: action.to,
        cc: action.cc,
        bcc: action.bcc,
        subject: action.subject,
        content: action.content,
        folderName: action.folderName,
        url: action.url,
        delayInMinutes: action.delayInMinutes,
      })),
    }));
  }, [data]);

  const downloadFile = useCallback(
    (content: string, mimeType: string, ext: string) => {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `inbox-zero-rules-${new Date().toISOString().split("T")[0]}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [],
  );

  const exportRulesAsYaml = useCallback(() => {
    const exportData = buildExportData();
    if (!exportData) return;
    downloadFile(stringify(exportData), "text/yaml", "yaml");
    toast.success("Rules exported as YAML");
  }, [buildExportData, downloadFile]);

  const exportRulesAsJson = useCallback(() => {
    const exportData = buildExportData();
    if (!exportData) return;
    downloadFile(JSON.stringify(exportData, null, 2), "application/json", "json");
    toast.success("Rules exported as JSON");
  }, [buildExportData, downloadFile]);

  const importRules = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const isYaml = file.name.endsWith(".yaml") || file.name.endsWith(".yml");
        const parsed = isYaml ? parse(text) : JSON.parse(text);
        const rulesArray = Array.isArray(parsed) ? parsed : parsed.rules;

        if (!Array.isArray(rulesArray) || rulesArray.length === 0) {
          toastError({ description: "Invalid rules file format" });
          return;
        }

        const result = await importRulesAction(emailAccountId, {
          rules: rulesArray,
        });

        if (result?.serverError) {
          toastError({
            title: "Import failed",
            description: result.serverError,
          });
        } else if (result?.data) {
          const { createdCount, updatedCount, skippedCount } = result.data;
          toast.success(
            `Imported ${createdCount} new, updated ${updatedCount} existing${skippedCount > 0 ? `, skipped ${skippedCount}` : ""}`,
          );
          mutate();
        }
      } catch (error) {
        toastError({
          title: "Import failed",
          description:
            error instanceof Error ? error.message : "Failed to parse file",
        });
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [emailAccountId, mutate],
  );

  return (
    <>
      <ItemSeparator />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>Import / Export Rules</ItemTitle>
        </ItemContent>
        <ItemActions>
          <input
            type="file"
            ref={fileInputRef}
            accept=".json,.yaml,.yml"
            onChange={importRules}
            className="hidden"
            aria-label="Import rules from JSON or YAML file"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon className="mr-2 size-4" />
            Import
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={exportRulesAsYaml}
            disabled={!data?.length}
          >
            <DownloadIcon className="mr-2 size-4" />
            Export YAML
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={exportRulesAsJson}
            disabled={!data?.length}
          >
            <DownloadIcon className="mr-2 size-4" />
            Export JSON
          </Button>
        </ItemActions>
      </Item>
    </>
  );
}
