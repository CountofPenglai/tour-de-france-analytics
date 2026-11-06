/* Display-only helpers: all standings and stage counts come from the existing API. */
(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function raceSummary(meta) {
    if (!meta || !meta.riders?.length || !meta.stages?.length || !meta.teams?.length) return null;
    return { starters: meta.riders.length, finishers: meta.riders.filter(r => Number(r.finished_race_flag) === 1).length,
      teams: meta.teams.length, stages: meta.stages.length,
      distance: meta.stages.every(s => s.distance_km != null) ? meta.stages.reduce((a,s) => a + Number(s.distance_km), 0) : null };
  }
  function stageChartMarkup(rows) {
    if (!rows.length) return '<p class="chart-empty">No stages match the current scope.</p>';
    const valid = rows.filter(r => r.finisher_count != null && Number.isFinite(Number(r.finisher_count)));
    if (!valid.length) return '<p class="chart-empty">No stage finisher counts available.</p>';
    const counts=valid.map(r=>Number(r.finisher_count));
    const lowest=Math.min(...counts), highest=Math.max(...counts);
    const floor=Math.max(0,Math.floor((lowest-2)/5)*5);
    const ceiling=Math.max(floor+10,Math.ceil((highest+2)/5)*5);
    const step=890/Math.max(1,rows.length-1);
    const y=value=>140-(value-floor)*100/(ceiling-floor);
    const point=(r,i)=>[44+i*step,y(Number(r.finisher_count))];
    const paths=[];let segment=[];
    rows.forEach((r,i)=>{if(r.finisher_count==null){if(segment.length)paths.push(segment);segment=[];}else segment.push(point(r,i));});
    if(segment.length)paths.push(segment);
    const grids=[floor,Math.round((floor+ceiling)/2),ceiling].map(value=>`<line x1="44" y1="${y(value)}" x2="942" y2="${y(value)}" stroke="#e0e8eb"/><text x="33" y="${y(value)+4}" text-anchor="end">${value}</text>`).join('');
    const lines=paths.map(p=>`<path d="M${p.map(x=>x.join(',')).join(' L')}" fill="none" stroke="#008d89" stroke-width="3"/>`).join('');
    const dots = rows.map((r,i) => {
      if(r.finisher_count == null) return '';
      const [x,y]=point(r,i), label=`Stage ${r.stage_id}: ${r.finisher_count} finishers`;
      return `<g role="button" tabindex="0" data-stage-id="${Number(r.stage_id)}" aria-label="${escape(label)} — open stage results"><title>${escape(label)} · ${escape(r.stage_type)} · ${escape(r.route_description)}</title><circle class="chart-hit" cx="${x}" cy="${y}" r="11" fill="transparent"/><circle class="chart-point" cx="${x}" cy="${y}" r="4" fill="#fff" stroke="#008d89" stroke-width="2"/>${i%4===0||i===rows.length-1?`<text x="${x}" y="166" text-anchor="middle">S${r.stage_id}</text>`:''}</g>`;
    }).join('');
    return `<svg viewBox="0 16 968 175" role="group" aria-label="Stage finishers; activate a point to inspect results">${grids}${lines}${dots}</svg>`;
  }
  function chartTabForModule(module) {
    const tabs = {rider_standings:[2,"tab_2_classifications"],team_standings:[3,"tab_3_performance"],stage_summary:[1,"tab_1_overview"],country_participation:[4,"tab_4_countries"],rider_specialisation:[5,"tab_5_insights"],gc_evolution:[5,"tab_5_insights"],team_depth:[5,"tab_5_insights"]};
    const [index,key] = tabs[module] || tabs.stage_summary;
    return {index,key};
  }
  const api = { raceSummary, stageChartMarkup, chartTabForModule };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RaceAppearance = api;
})(typeof window !== 'undefined' ? window : globalThis);
