// Localized strings for the Graphics settings section. The rest of the game
// ships in English; the panel follows navigator.language.

const EN = {
  legend: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})', renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so the game renders without it.',
  fallback: '3D graphics are unavailable; these settings apply when the 3D renderer runs.',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing', particles: 'Particles', background: 'Background motion', detail: 'Scene detail' },
  tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Static', animated: 'Animated', plain: 'Plain', detailed: 'Detailed' },
  words: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion', bloom: 'bloom', sparks: 'sparks', noAA: 'no anti-aliasing' },
};

const EN_GB = { ...EN, cats: { ...EN.cats, grade: 'Colour grade' }, words: { ...EN.words } };

const ES_419 = {
  legend: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})', renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})', adaptive: 'Resolución adaptable', showFps: 'Mostrar cuadros por segundo',
  postFailed: 'El posprocesamiento no está disponible en este dispositivo; el juego se muestra sin él.',
  fallback: 'Los gráficos 3D no están disponibles; estos ajustes se aplican cuando se usa el renderizador 3D.',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Antialiasing', particles: 'Partículas', background: 'Movimiento del fondo', detail: 'Detalle de la escena' },
  tiers: { off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Simple', detailed: 'Detallado' },
  words: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoFull: 'oclusión ambiental completa', bloom: 'resplandor', sparks: 'chispas', noAA: 'sin antialiasing' },
};
const ES_ES = {
  ...ES_419, renderScale: 'Escala de renderizado', showFps: 'Mostrar fotogramas por segundo',
  fallback: 'Los gráficos 3D no están disponibles; estos ajustes se aplican cuando se usa el renderizador 3D.',
  tiers: { ...ES_419.tiers },
};

const DE = {
  legend: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', renderScale: 'Renderskalierung',
  fromPreset: 'Aus Voreinstellung ({tier})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Spiel wird ohne sie dargestellt.',
  fallback: '3D-Grafik ist nicht verfügbar; diese Einstellungen gelten für den 3D-Renderer.',
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur', antialias: 'Kantenglättung', particles: 'Partikel', background: 'Hintergrundbewegung', detail: 'Szenendetails' },
  tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statisch', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert' },
  words: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoFull: 'volle Umgebungsverdeckung', bloom: 'Bloom', sparks: 'Funken', noAA: 'keine Kantenglättung' },
};

const FR = {
  legend: 'Graphismes', quality: 'Qualité', auto: 'Automatique (détectée : {tier})', renderScale: 'Échelle de rendu',
  fromPreset: 'Selon le préréglage ({tier})', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
  postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le jeu s’affiche sans.',
  fallback: 'Les graphismes 3D ne sont pas disponibles ; ces réglages s’appliquent au moteur 3D.',
  presets: { low: 'Faible', balanced: 'Équilibrée', high: 'Élevée', ultra: 'Ultra' },
  cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage', particles: 'Particules', background: 'Animation du décor', detail: 'Détails de la scène' },
  tiers: { off: 'Désactivé', on: 'Activé', low: 'Faible', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé' },
  words: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoFull: 'occlusion ambiante complète', bloom: 'halo', sparks: 'étincelles', noAA: 'sans anticrénelage' },
};
const FR_CA = { ...FR, fallback: 'Les graphiques 3D ne sont pas disponibles; ces réglages s’appliquent au moteur 3D.', legend: 'Graphiques', auto: 'Automatique (détectée : {tier})' };

const PT_BR = {
  legend: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})', renderScale: 'Escala de renderização',
  fromPreset: 'Da predefinição ({tier})', adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
  postFailed: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
  fallback: 'Gráficos 3D indisponíveis; estas configurações valem quando o renderizador 3D estiver ativo.',
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento', particles: 'Partículas', background: 'Movimento do cenário', detail: 'Detalhes da cena' },
  tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado' },
  words: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão ambiente', aoFull: 'oclusão ambiente completa', bloom: 'brilho', sparks: 'faíscas', noAA: 'sem antisserrilhamento' },
};

const IT = {
  legend: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', renderScale: 'Scala di rendering',
  fromPreset: 'Dal preset ({tier})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il gioco viene mostrato senza.',
  fallback: 'La grafica 3D non è disponibile; queste impostazioni valgono per il renderer 3D.',
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing', particles: 'Particelle', background: 'Movimento dello sfondo', detail: 'Dettagli della scena' },
  tiers: { off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato' },
  words: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoFull: 'occlusione ambientale completa', bloom: 'bagliore', sparks: 'scintille', noAA: 'senza antialiasing' },
};

export const GFX_STRINGS = {
  'en-US': EN, 'en-GB': EN_GB, 'es-419': ES_419, 'es-ES': ES_ES, 'de-DE': DE,
  'fr-FR': FR, 'fr-CA': FR_CA, 'pt-BR': PT_BR, 'it-IT': IT,
};

const FALLBACK_BY_LANG = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

export function pickLocale(lang) {
  const l = String(lang || 'en-US');
  if (GFX_STRINGS[l]) return l;
  const lower = l.toLowerCase();
  if (lower === 'es' || lower === 'es-es') return 'es-ES';
  if (/^en-(gb|au|nz|ie|za|in)/.test(lower)) return 'en-GB';
  const exact = Object.keys(GFX_STRINGS).find((k) => k.toLowerCase() === lower);
  if (exact) return exact;
  return FALLBACK_BY_LANG[lower.split('-')[0]] || 'en-US';
}

export function gfxStrings(lang = (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) {
  return GFX_STRINGS[pickLocale(lang)];
}

export function fmt(s, vars) { return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')); }
