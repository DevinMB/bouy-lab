// Correlation color scale, shared by the Research matrix/teleconnections and the
// map overlay. Solid colors so it's legible on both heatmap cells and small map
// markers: grey at r≈0, deepening to green (+1) or red (−1) by magnitude.
const GREY = [120, 130, 135]
const POS = [34, 197, 94]
const NEG = [239, 68, 68]

export function corrColor(r) {
  if (r == null) return '#3a4a52' // unknown / too little overlap — dim
  const m = Math.min(1, Math.abs(r))
  const target = r >= 0 ? POS : NEG
  const mix = GREY.map((g, i) => Math.round(g + (target[i] - g) * m))
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`
}

export function corrGradient() {
  return `linear-gradient(to right, ${corrColor(-1)}, ${corrColor(0)}, ${corrColor(1)})`
}
