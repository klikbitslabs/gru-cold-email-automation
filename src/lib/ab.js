// Supervised A/B testing: the system *recommends* (pause a losing variant, generate a challenger
// for the winner); a person approves each recommendation. Nothing changes automatically.

export const AB_MIN_SENDS = 30;
const SIGNIFICANCE_Z = 1.645; // ~90% one-sided

/** Two-proportion z statistic (a better than b). */
export function zScore(successA, totalA, successB, totalB) {
  if (!totalA || !totalB) return 0;
  const pA = successA / totalA;
  const pB = successB / totalB;
  const pooled = (successA + successB) / (totalA + totalB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  return se ? (pA - pB) / se : 0;
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/**
 * @param groups Array<{ step_number, segment, variants: [{ id, label, status, sent, opened, replied, positive }] }>
 * @returns Array of recommendations { type: 'pause'|'challenge'|'collect', ... }
 */
export function abRecommendations(groups, { minSends = AB_MIN_SENDS } = {}) {
  const out = [];
  for (const g of groups) {
    const active = g.variants.filter((v) => v.status === 'active');
    const where = `Paso ${g.step_number}${g.segment ? ` · ${g.segment}` : ''}`;
    if (!active.length) continue;
    if (active.length === 1) {
      out.push({
        type: 'challenge',
        step_number: g.step_number,
        segment: g.segment,
        variant_id: active[0].id,
        title: `${where}: solo hay una variante activa`,
        reason: `Genera 1–2 retadores de "${active[0].label}" para seguir aprendiendo.`,
      });
      continue;
    }
    const pending = active.filter((v) => v.sent < minSends);
    if (pending.length) {
      out.push({
        type: 'collect',
        step_number: g.step_number,
        segment: g.segment,
        title: `${where}: recolectando datos`,
        reason: `Se necesitan al menos ${minSends} envíos por variante (faltan: ${pending.map((v) => `${v.label} ${v.sent}/${minSends}`).join(', ')}).`,
      });
      continue;
    }
    // Primary metric: replies (any reply), with positive replies as tie-breaker; opens for subjects.
    const ranked = [...active].sort((a, b) => b.replied / b.sent - a.replied / a.sent || b.positive / b.sent - a.positive / a.sent);
    const best = ranked[0];
    let paused = false;
    for (const v of ranked.slice(1)) {
      const zReply = zScore(best.replied, best.sent, v.replied, v.sent);
      const zOpen = zScore(best.opened, best.sent, v.opened, v.sent);
      if (zReply >= SIGNIFICANCE_Z || (zOpen >= SIGNIFICANCE_Z * 1.5 && best.replied >= v.replied)) {
        paused = true;
        out.push({
          type: 'pause',
          step_number: g.step_number,
          segment: g.segment,
          variant_id: v.id,
          winner_id: best.id,
          title: `${where}: pausar "${v.label}"`,
          reason: `"${best.label}" rinde mejor: respuesta ${pct(best.replied, best.sent)}% vs ${pct(v.replied, v.sent)}%, apertura ${pct(best.opened, best.sent)}% vs ${pct(v.opened, v.sent)}% (${best.sent} y ${v.sent} envíos).`,
          confidence: zReply >= SIGNIFICANCE_Z ? 'respuesta (90%)' : 'apertura (alta)',
        });
      }
    }
    if (paused || active.length < 3) {
      out.push({
        type: 'challenge',
        step_number: g.step_number,
        segment: g.segment,
        variant_id: best.id,
        title: `${where}: crear retador para "${best.label}"`,
        reason: 'Mantén siempre una variante nueva compitiendo contra la ganadora.',
      });
    } else {
      out.push({
        type: 'collect',
        step_number: g.step_number,
        segment: g.segment,
        title: `${where}: sin diferencia significativa todavía`,
        reason: 'Las variantes rinden parecido; sigue enviando para separar ganadora y perdedoras.',
      });
    }
  }
  return out;
}
