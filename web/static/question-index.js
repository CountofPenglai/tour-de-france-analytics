(function () {
  'use strict';

  // Titles and numbering follow the instructor's OLAP Demonstration Prompts.
  // Preferences select an existing presentation; global filters stay in place.
  const teamView = {showBurden:false,scoringMethod:null};
  const stageView = {stageId:null,stageSort:null,stageRiderKey:null,stageTeamKey:null,stageFull:false};
  const questions = [
    {id:'E1',title:'GC leaderboard with contextual descent',
      summary:'Overall GC → rider → the day that most changed their standing.',
      destination:'Classifications',module:'rider_standings',target:'.analysis-block',
      preferences:{classScope:null,search:'',age:'',sort:'gc'}},
    {id:'E2',title:'A stage in focus',
      summary:'Route, leading finishers, adjusted times and top-ten places by team.',
      destination:'Stages & Routes',module:'stage_summary',target:'[data-evidence-heading]',
      preferences:{...stageView,stageMode:'order',stageTypes:[]}},
    {id:'E3',title:'Team burden and contribution',
      summary:'Combined team time → rider contributions → daily results.',
      destination:'Riders & Teams',module:'team_standings',target:'#tt-burden',
      preferences:{...teamView,burdenSort:'most'}},
    {id:'E4',title:'Parallel classifications',
      summary:'GC, Young Rider GC and mountain-stage GC side by side.',
      destination:'Classifications',module:'rider_standings',target:'.analysis-block',
      preferences:{classScope:null,search:'',age:'',sort:'gc'}},
    {id:'E5',title:'Mountain contours',
      summary:'Mountain podium frequency and mean gap to the stage winner.',
      destination:'Stage Type Fit',module:'rider_specialisation',target:'#tt-mountain',
      preferences:{entityKind:'rider',terrainType:'mountain',showMountain:false,mountainSort:'rate'}},
    {id:'E6',title:'Speed as a simple ratio',
      summary:'Rider and team speed across Flat, Hilly, Mountain and ITT.',
      destination:'Stage Type Fit',module:'rider_specialisation',target:'#tt-profiles',
      preferences:{entityKind:'rider',showLeaders:false}},
    {id:'E7',title:'Bonuses, penalties, and counterfactuals',
      summary:'Remove bonuses or penalties and compare the GC top ten.',
      destination:'Time Rules',module:'time_rules',target:'.analysis-block',
      preferences:{bonuses:true,penalties:true,sort:'baseline_rank'}},
    {id:'E8',title:'Participation by nation',
      summary:'National riders, registered teams and the people behind each count.',
      destination:'Country Participation',module:'country_participation',target:'.country-overview',
      preferences:{countryCode:null,countrySortKey:'rider_count',countrySortDesc:true}},
    {id:'E9',title:'National outcomes (within available data)',
      summary:'Best national GC rank, stage wins, podiums and supporting results.',
      destination:'Country Participation',module:'country_participation',target:'.country-table-block',
      preferences:{countryCode:null,countrySortKey:'best_gc_rank',countrySortDesc:false}},
    {id:'E10',title:'Temporal GC storyline',
      summary:'Cumulative adjusted time, mountain stages and changes in the GC race.',
      destination:'Decisive Stages',module:'gc_evolution',target:'.analysis-block',
      preferences:{chartMode:'time'}},
    {id:'E11',title:'Against the clock',
      summary:'The ITT catalogue: dates, distances and stage winners.',
      destination:'Stages & Routes · ITT',module:'stage_summary',target:'.analysis-block',
      preferences:{...stageView,stageMode:'order',stageTypes:['individual time-trial']}},
    {id:'E12',title:'Consistency near the front',
      summary:'Riders with the most top-ten finishes, and their contributing stages.',
      destination:'Riders & Teams · All riders',module:'team_standings',target:'#tt-roster',
      preferences:{...teamView,rosterMode:'all',riderSearch:'',riderSort:'top10'}},
    {id:'E13',title:'Depth of squads',
      summary:'Compare roster sizes, then inspect each team’s riders and nationalities.',
      destination:'Riders & Teams · Squad depth',module:'team_standings',target:'.tt-all-teams',
      preferences:{...teamView,rosterMode:'roster',teamsOpen:true,teamSearch:'',teamSort:'participants',teamAscending:false}},
    {id:'E14',title:'Top-ten intensity by team',
      summary:'Team top-ten finishes by stage type → riders → stages.',
      destination:'Riders & Teams · Stage types',module:'team_standings',target:'#tt-breakdown',
      preferences:{...teamView}},
    {id:'E15',title:'The long day',
      summary:'The longest route, its essential details and the leading finishers.',
      destination:'Stages & Routes · Longest routes',module:'stage_summary',target:'.analysis-block',
      preferences:{...stageView,stageMode:'longest',stageTypes:[]}},
  ];
  const esc = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');

  function mount(element, {go,isCurrent,findTarget,focus}) {
    let sequence = 0;
    element.innerHTML = '<p class="question-index-caption">OLAP demonstration prompts <span>E1–E15</span></p>' +
      '<ol class="question-grid">' + questions.map(q=>'<li><button type="button" class="question-card" data-question="'+q.id+'">'+
        '<span class="question-number">'+q.id+'</span><strong class="question-title">'+esc(q.title)+'</strong>'+
        '<span class="question-summary">'+esc(q.summary)+'</span><span class="question-destination">'+esc(q.destination)+
        '<span aria-hidden="true">↗</span></span></button></li>').join('')+'</ol>';
    element.onclick = async event => {
      const button = event.target.closest('[data-question]');
      if (!button || !element.contains(button)) return;
      const question = questions.find(q=>q.id===button.dataset.question);
      if (!question) return;
      const request = ++sequence;
      await go(question.module,structuredClone(question.preferences));
      if (request === sequence && isCurrent(question.module)) focus(findTarget(question.target));
    };
  }
  window.RaceQuestionIndex = {mount};
})();
