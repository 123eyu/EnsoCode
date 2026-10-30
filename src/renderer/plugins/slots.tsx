import { parsePluginToolName } from '@shared/extensionPlugins/toolName';
import { PluginSlotView } from './loader';
import { pluginBlock, pluginComposerSlots, pluginMessageActions, pluginToolCard } from './registry';
import { usePluginSlotsVersion } from './usePluginSlots';

export function PluginMessageActions({ position }: { position: 'left' | 'right' }) {
  usePluginSlotsVersion();
  const actions = pluginMessageActions(position);
  if (actions.length === 0) return null;
  return (
    <>
      {actions.map((entry) => (
        <PluginSlotView key={`${entry.pluginId}:${position}`} entry={entry} props={{ position }} />
      ))}
    </>
  );
}

export function PluginToolCardSlot({
  name,
  output,
  state,
}: {
  name: string;
  output: string | null;
  state: string;
}) {
  usePluginSlotsVersion();
  const parsed = parsePluginToolName(name);
  if (!parsed) return null;
  const entry = pluginToolCard(parsed.pluginId, parsed.toolName);
  if (!entry) return null;
  return <PluginSlotView entry={entry} props={{ toolName: parsed.toolName, output, state }} />;
}

export function PluginBlock({
  pluginId,
  lang,
  source,
}: {
  pluginId: string;
  lang: string;
  source: string;
}) {
  usePluginSlotsVersion();
  const entry = pluginBlock(pluginId, lang);
  if (!entry) return null;
  return <PluginSlotView entry={entry} props={{ language: lang, source }} />;
}

export function PluginComposerSlots({ side }: { side: 'left' | 'right' }) {
  usePluginSlotsVersion();
  const slots = pluginComposerSlots(side);
  if (slots.length === 0) return null;
  return (
    <>
      {slots.map((entry) => (
        <PluginSlotView
          key={`${entry.pluginId}:${side}`}
          entry={entry}
          props={{ position: side }}
        />
      ))}
    </>
  );
}
