# Monitor tecnico Bianchino Preview

**Monitor attivo dal 26 ottobre 2026**, con arresto dei controlli il 1 novembre 2026 alle 07:11:27 UTC. Un solo test email controllato eseguito, ricevuto e preso in carico dal responsabile. Il job negativo della prova è intenzionale; il controllo sano successivo è riuscito. Non ripetere il test senza un nuovo consenso.

Pacchetto separato dall’applicazione. Solo codice del monitor e configurazione pubblica della Preview; nessun dato cliente o segreto.

Controllo previsto ogni 15 minuti fino a 2026-11-01T07:11:27Z; GitHub può ritardare le esecuzioni. Il programma ferma richieste e avvisi alla scadenza; il workflow si disattiva alla prima esecuzione successiva. Il processo di monitoraggio dipende dalla disponibilità di GitHub e dal servizio email. Non è una garanzia di disponibilità continua.

Il segreto Vercel viene inviato solo in header al target configurato; redirect non seguiti. Nessuna credenziale dell’account applicativo, del database o del vault è necessaria.

Dopo due riscontri negativi consecutivi, gli avvisi sono abilitati solo se la variabile MONITOR_NOTIFICATIONS_ENABLED è true e i segreti dedicati sono presenti. Chiave idempotente e contenuto identici per intervallo fisso di 15 minuti; la risposta del provider non dimostra la ricezione.

Segreti GitHub Actions richiesti: MONITOR_PROTECTION_BYPASS; per gli avvisi anche MONITOR_RESEND_API_KEY, MONITOR_ALERT_FROM e MONITOR_ALERT_TO. Mai inserirli nel codice, negli output o in questo documento.

La prova manuale test_alert richiede un percorso fisso inesistente sullo stesso target e, con avvisi attivi, invia un messaggio dichiaratamente di prova. Non arresta l’app e non simula una perdita del provider. Eseguirla soltanto dopo autorizzazione del destinatario.

Locale: node monitor.mjs --profile /percorso/profilo-privato.env. Le email sono disabilitate senza --notify.

I job sono abilitati in gabrielevaudano98/Bianchino-monitor; i fork non eseguono i job di controllo. Alla scadenza rimuovere i segreti e revocare l’accesso dedicato presso Vercel, senza toccare quelli degli altri ambienti.
