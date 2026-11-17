import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const objectOptions = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.Object({ en: Type.String({ minLength: 1, maxLength }), my: Type.String({ minLength: 1, maxLength }) }, objectOptions);
const color = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });
const palette = Type.Object({
  background: Type.Optional(color),
  surface: Type.Optional(color),
  surfaceSubtle: Type.Optional(color),
  text: Type.Optional(color),
  muted: Type.Optional(color),
  border: Type.Optional(color),
  divider: Type.Optional(color),
  primary: Type.Optional(color),
  onPrimary: Type.Optional(color),
  accent: Type.Optional(color),
  onAccent: Type.Optional(color),
  brandBackground: Type.Optional(color),
  brandText: Type.Optional(color),
  secondary: Type.Optional(color),
  secondaryBorder: Type.Optional(color),
  selected: Type.Optional(color),
  selectedBorder: Type.Optional(color),
  link: Type.Optional(color),
  placeholder: Type.Optional(color),
  error: Type.Optional(color),
  errorBackground: Type.Optional(color),
  errorBorder: Type.Optional(color),
  resultBackground: Type.Optional(color),
  resultText: Type.Optional(color),
  resultMuted: Type.Optional(color),
  resultWarning: Type.Optional(color),
  switchOn: Type.Optional(color),
  switchOff: Type.Optional(color),
}, objectOptions);
export const RemoteConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  revision: Type.String({ minLength: 1, maxLength: 80 }),
  theme: Type.Object({ light: palette, dark: palette }, objectOptions),
  carousel: Type.Array(Type.Object({
    id: Type.String({ pattern: '^[a-z0-9-]{1,40}$' }),
    label: text(80), title: text(120), body: text(400), action: text(60),
    route: Type.Union([Type.Literal('/severance'), Type.Literal('/severance/guide'), Type.Literal('/insurance')]),
    color, art: Type.Union([Type.Literal('calculator'), Type.Literal('coins'), Type.Literal('insurance')]),
  }, objectOptions), { maxItems: 8 }),
  notices: Type.Array(Type.Object({ id: Type.String({ pattern: '^[a-z0-9-]{1,40}$' }), title: text(120), body: text(1500) }, objectOptions), { maxItems: 20 }),
  features: Type.Object({ carouselVisible: Type.Boolean(), carouselAutoplay: Type.Boolean(), carouselIntervalMs: Type.Integer({ minimum: 4000, maximum: 30000 }), noticesVisible: Type.Boolean() }, objectOptions),
}, objectOptions);
export type RemoteConfig = Static<typeof RemoteConfigSchema>;
export const defaultRemoteConfig: RemoteConfig = {
  schemaVersion: 1, revision: 'bundled-v1', theme: { light: {}, dark: {} }, carousel: [], notices: [],
  features: { carouselVisible: true, carouselAutoplay: true, carouselIntervalMs: 4000, noticesVisible: true },
};
// Public presentation data only. Read at startup; Render environment changes
// require a restart/deploy approved by the owner. No database or admin endpoint.
export function configuredRemoteConfig(raw = process.env.REMOTE_CONFIG_JSON): RemoteConfig {
  if (!raw || Buffer.byteLength(raw) > 32768) return structuredClone(defaultRemoteConfig);
  try {
    const value: unknown = JSON.parse(raw);
    if (Value.Check(RemoteConfigSchema, value) &&
        new Set(value.carousel.map(item => item.id)).size === value.carousel.length &&
        new Set(value.notices.map(item => item.id)).size === value.notices.length) return value;
  } catch { /* A malformed operator setting must not affect financial routes. */ }
  return structuredClone(defaultRemoteConfig);
}
