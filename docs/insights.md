# Source-grounded Analytical Findings

Scope: supplied 2025 course CSVs, final full-race scope, adjusted time unless stated otherwise. Reproduce the sporting findings through the shared analytical functions and Explore views. Re-run benchmarks using the README commands; execution times vary by host.

## Team rankings depend on the question

Visma leads under both methods. UAE ranks second using each stage's fastest three riders, ahead of Red Bull by 3,673 seconds. Red Bull ranks second using the fastest three full-race finishers, ahead of UAE by 32 seconds. The first method permits different contributors each day; the second emphasizes three consistently competitive finishers. Team-planning discussions should state which strength they value.

## Wins and roster depth tell different stories

UAE records 5 stage wins versus Visma's 2. Visma places a rider in the top 10 on 18 of 21 stages (85.71%), versus UAE's 15 (71.43%). Seven distinct Visma riders contribute top-10 finishes versus five for UAE; all eight Visma riders finish versus seven UAE riders. Coverage can indicate repeated sporting visibility, but does not measure actual media exposure, sponsorship return, salary efficiency or causation.

## Define what makes a stage decisive

For the eventual top five adjusted-GC finishers, define daily gap change as the change in cumulative gap to that day's leader. The range of these changes within the group is greatest on stage 12 (252 seconds), followed by stage 16 (170 seconds) and stage 5 (168 seconds). This highlights mountain and time-trial days for inspection. It is retrospective evidence about eventual top-five finishers, not a prospective prediction or an official difficulty measure.

## Separate bonuses from riding time

The raw cumulative gap between Pogacar and Vingegaard is 246 seconds. Their net bonuses are 52 and 34 seconds respectively, producing an adjusted gap of 264 seconds. The 18-second difference is explained by the source bonus and penalty fields and is visible through the time-basis toggle.

## Registration differs from nationality

France supplies 38 riders and registers 5 teams; Belgium supplies 29 and registers 4. UAE registers one team but supplies no rider of that nationality in this dataset. Its rider completion rate is undefined, not zero. Nationality analysis uses 183 known-nationality riders. Vlasov's source nationality remains unknown, while his 21 results and team contribution remain included elsewhere. These figures describe sporting participation and registration, not commercial market size.

## Star-schema benefits are query-dependent

All three benchmark pairs return exactly equal results. In the original development-machine run of seven warmed alternating repetitions, the route/terrain query reduces SQL joins from 7 to 3 and median planning-plus-execution time from 5.718 ms to 2.579 ms. The star GC query is slightly slower overall (2.762 ms versus 2.584 ms); the team query is close (5.144 ms versus 5.293 ms). Reduced route-query complexity and shared BI semantics come with redundancy and ETL maintenance. This small warm-cache experiment does not establish a universal speed advantage.
