import { Trans, useLingui } from "@lingui/react/macro";
import type { ChatModelChoice } from "@rakazo/core";
import { filterModelChoices, MODEL_SEARCH_THRESHOLD } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

/** A chat's model: a native select, or a searchable list once there are too many to scan. */
export function ChatModelPicker({
  id,
  choices,
  value,
  onChange,
}: {
  id: string;
  choices: readonly ChatModelChoice[];
  value: string;
  onChange: (key: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matched = useMemo(() => filterModelChoices(choices, query), [choices, query]);

  if (choices.length <= MODEL_SEARCH_THRESHOLD) {
    return (
      <NativeSelect
        id={id}
        className="mt-2 w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {choices.map((choice) => (
          <NativeSelectOption key={choice.key} value={choice.key}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        id={id}
        className="mt-2 flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent pr-2.5 pl-2.5 text-start text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
      >
        <span className="min-w-0 truncate">
          {choices.find((choice) => choice.key === value)?.label ?? choices[0]?.label}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      {open ? (
        <PopoverContent align="start" className="w-(--anchor-width) gap-0 overflow-hidden p-0">
          <Command shouldFilter={false} className="rounded-none bg-transparent">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t`Search`}
              aria-label={t`Search models`}
            />
            <CommandList>
              <CommandEmpty>
                <Trans>No matching models</Trans>
              </CommandEmpty>
              {matched.map((choice) => (
                <CommandItem
                  key={choice.key}
                  // cmdk falls back to the row's text for an empty value.
                  value={choice.key || "space-default"}
                  data-checked={choice.key === value}
                  onSelect={() => {
                    onChange(choice.key);
                    openChange(false);
                  }}
                >
                  <span className="min-w-0 truncate">{choice.label}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
