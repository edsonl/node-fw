# Prompt — Painel provisório de observação da Fase 4A

Você vai trabalhar no projeto existente `/home/edson/www/node-fw/`. Leia primeiro `docs/IMPLEMENTACAO.md`, `docs/ARQUITETURA.md`, `docs/NGINX.md`, `package.json` e o código atual de API, coletor e Redis. Implemente somente o painel provisório de observação descrito abaixo, antes de iniciar a Fase 5 (MaxMind).

## Objetivo

Permitir que a equipe acompanhe visualmente os acessos reais do site piloto `casadoppia.site` durante o soak de 24 horas da Fase 4. Este é um incremento pequeno, operacional, somente de leitura. O painel administrativo completo continua planejado para a Fase 7.

## Antes de alterar

- Inspecione como o app Fastify é iniciado, como a configuração controla o bind da API, como o `src/storage/queries.js` consulta o Redis e como os eventos são escritos no stream.
- Confira o formato exato dos eventos armazenados. Não invente campos nem presuma a semântica do cursor do Redis.
- Proponha a menor solução coerente com a estrutura já existente. Prefira servir UI e API na mesma origem e evitar dependências pesadas novas.
- Não altere Nginx, Fail2Ban, iptables, Redis do sistema, systemd, produção ou qualquer serviço externo.

## Funcionalidade necessária

1. Criar uma tela simples e responsiva de monitoramento com tabela/lista de eventos recentes.
2. Mostrar, quando existirem no evento: horário, site, IP, método, caminho sem query string, status HTTP, tempo de resposta, indicador de requisição dinâmica e User-Agent truncado.
3. Permitir filtro por site, IP e status. Validar filtros e limites no servidor; limitar a quantidade máxima por página.
4. Implementar consulta paginada/cursorizada do stream Redis já existente. Não varrer todas as chaves, não fazer `KEYS`, não buscar todo o stream e não criar retenção ilimitada. Usar ordem mais recente primeiro, cursor estável, tamanho de página limitado e resposta sem segredo.
5. Atualizar periodicamente com intervalo moderado e mostrar estado de carregamento, erro, vazio e horário da última atualização. Evitar recarregar toda a página.
6. Exibir também os indicadores existentes em `/api/stats` e `/api/summary`: eventos/contagens recentes, status HTTP, eventos inválidos por motivo, profundidade da fila e prontidão do Redis. Se um indicador não estiver disponível, mostrar indisponível, sem inventar valor.
7. Tornar a tela útil sem MaxMind: país, ASN, score e nível de risco não estão disponíveis nesta fase e não devem ser simulados.

## Segurança e privacidade

- Interface e endpoints novos devem ser somente leitura: sem banir IP, editar regras, apagar dados ou mudar configurações.
- Restringir o serviço à interface loopback (`127.0.0.1`/`::1`) para esta etapa. Verifique a configuração atual e imponha um bind seguro por default. Não habilite bind público para facilitar o acesso.
- Não criar proxy público nem instruções que exponham a porta à Internet. Se houver acesso remoto necessário, deixar isso para desenho posterior com autenticação e TLS.
- Nunca retornar nem renderizar query string, cookies, `Authorization`, corpo de requisição ou credenciais. Tratar User-Agent e demais dados como texto não confiável; escapar na UI e truncar no servidor.
- Aplicar limites de paginação, filtros, frequência de atualização e tamanho de resposta.
- Não logar conteúdo integral de eventos nem filtros sensíveis além do necessário.

## Fora de escopo

- Vue/Quasar ou painel administrativo completo, salvo se já houver estrutura útil no repositório.
- Autenticação administrativa e gestão de usuários (planejadas para Fase 7, mantendo loopback nesta fase).
- WebSocket, MaxMind, score, classificação, listas de bloqueio/exceção e integração Fail2Ban.
- Alterações na configuração de sites Nginx ou expansão para outros sites.
- Qualquer bloqueio automático ou manual.

## Documentação e entrega

- Atualize `docs/IMPLEMENTACAO.md` e, se a arquitetura efetiva mudar, `docs/ARQUITETURA.md`.
- Crie um guia curto de uso em `docs/PAINEL-OBSERVACAO.md`: como iniciar, abrir localmente, parar, campos e limitações.
- Registre explicitamente que a conclusão desta etapa não aprova por si só a Fase 5: o soak de 24 horas e os critérios restantes da Fase 4 precisam ser revisados e documentados.
- Ao concluir, resuma arquivos alterados, decisões, como iniciar e limitações. Não avance para MaxMind.

## Critérios de aceite

- Um operador local consegue ver eventos reais recentes e métricas de saúde durante o piloto.
- Paginação e filtros são limitados e usam o stream sem leitura ilimitada.
- API e UI não escutam em interfaces públicas por padrão.
- Nenhum campo proibido ou segredo é exibido; conteúdo do evento é escapado na interface.
- Nenhuma ação de escrita/bloqueio está disponível no painel.
- Documentação lista o procedimento de observação do soak e as limitações desta versão.
