// Command templates (Phase 2, CONTRACT-2 §1): named, reusable command
// definitions. Using a template creates a completely normal command (single
// or broadcast) with template_id recorded — audit and the verification gate
// behave exactly like manual commands, no shortcuts.

import type { CommandTemplate, PrismaClient } from '@prisma/client';
import { newId } from '../lib/crypto';
import { COMMAND_TYPES } from './commands';

export interface DefaultTemplate {
  name: string;
  type: string;
  description: string;
  sensitive: boolean;
}

/** Seeded at boot when absent (user edits are never overwritten). */
export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  { name: 'Cek Status Miner', type: 'miner.status', description: 'Minta snapshot status miner terkini dari agent', sensitive: false },
  { name: 'Jalankan Miner', type: 'miner.run', description: 'Jalankan miner (Run Lagi) — wajib terverifikasi heartbeat', sensitive: true },
  { name: 'Restart Miner', type: 'miner.restart', description: 'Restart service miner — wajib terverifikasi heartbeat', sensitive: true },
  { name: 'Tahan Auto-Recovery', type: 'miner.hold', description: 'Tahan pemulihan otomatis pada worker ini', sensitive: true },
  { name: 'Lepas Tahan Auto-Recovery', type: 'miner.unhold', description: 'Lanjutkan pemulihan otomatis pada worker ini', sensitive: true },
  { name: 'Reinstall Miner', type: 'miner.reinstall', description: 'Install ulang miner lalu jalankan — wajib terverifikasi heartbeat', sensitive: true },
  { name: 'Perbarui Bridge', type: 'bridge.update', description: 'Bridge cek versi terbaru di server; bila beda, pasang bundle baru + salinan agent.md terbaru lalu restart sendiri (CONTRACT-10)', sensitive: true },
];

/** Insert the default templates that are missing. Idempotent; called on boot. */
export async function seedCommandTemplates(prisma: PrismaClient): Promise<void> {
  for (const tpl of DEFAULT_TEMPLATES) {
    await prisma.commandTemplate.upsert({
      where: { name: tpl.name },
      update: {},
      create: {
        id: newId('tpl'),
        name: tpl.name,
        type: tpl.type,
        payload: {} as never,
        description: tpl.description,
        sensitive: tpl.sensitive,
      },
    });
  }
}

export interface TemplateInput {
  name: string;
  type: string;
  payload?: Record<string, unknown>;
  description?: string;
  sensitive?: boolean;
}

function assertValidType(type: string): void {
  if (!COMMAND_TYPES.includes(type as (typeof COMMAND_TYPES)[number])) {
    throw Object.assign(new Error(`Tipe perintah tidak dikenal: ${type}`), { statusCode: 400 });
  }
}

export async function createTemplate(prisma: PrismaClient, input: TemplateInput): Promise<CommandTemplate> {
  assertValidType(input.type);
  const name = input.name?.trim();
  if (!name) throw Object.assign(new Error('Nama template wajib diisi'), { statusCode: 400 });
  const existing = await prisma.commandTemplate.findUnique({ where: { name } });
  if (existing) {
    throw Object.assign(new Error(`Template bernama "${name}" sudah ada`), { statusCode: 409 });
  }
  return prisma.commandTemplate.create({
    data: {
      id: newId('tpl'),
      name,
      type: input.type,
      payload: (input.payload ?? {}) as never,
      description: input.description ?? '',
      sensitive: input.sensitive ?? false,
    },
  });
}

export async function updateTemplate(
  prisma: PrismaClient,
  id: string,
  patch: Partial<TemplateInput>,
): Promise<CommandTemplate> {
  const existing = await prisma.commandTemplate.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('TEMPLATE_NOT_FOUND'), { statusCode: 404 });
  if (patch.type !== undefined) assertValidType(patch.type);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw Object.assign(new Error('Nama template wajib diisi'), { statusCode: 400 });
    const clash = await prisma.commandTemplate.findUnique({ where: { name } });
    if (clash && clash.id !== id) {
      throw Object.assign(new Error(`Template bernama "${name}" sudah ada`), { statusCode: 409 });
    }
  }
  return prisma.commandTemplate.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.payload !== undefined ? { payload: patch.payload as never } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.sensitive !== undefined ? { sensitive: patch.sensitive } : {}),
    },
  });
}

export async function deleteTemplate(prisma: PrismaClient, id: string): Promise<void> {
  const existing = await prisma.commandTemplate.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('TEMPLATE_NOT_FOUND'), { statusCode: 404 });
  await prisma.commandTemplate.delete({ where: { id } });
}

/** Resolve a template by id or throw 404. */
export async function getTemplateOrThrow(prisma: PrismaClient, id: string): Promise<CommandTemplate> {
  const template = await prisma.commandTemplate.findUnique({ where: { id } });
  if (!template) throw Object.assign(new Error('TEMPLATE_NOT_FOUND'), { statusCode: 404 });
  return template;
}

/** Merge template payload with an explicit payload (explicit keys win). */
export function mergePayload(
  templatePayload: unknown,
  explicit?: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    templatePayload && typeof templatePayload === 'object' && !Array.isArray(templatePayload)
      ? (templatePayload as Record<string, unknown>)
      : {};
  return { ...base, ...(explicit ?? {}) };
}
