# Prompt — Fase 6: perfis geográficos de classificação

Implemente uma extensão da Fase 6 do Node FW para aplicar limites de classificação diferentes conforme o país de origem do IP, usando os bancos MaxMind Country/ASN já integrados.

O objetivo inicial é observar e calibrar os perfis, sem bloquear requisições:

- **Leve:** Brasil e Estados Unidos.
- **Intermediário:** países da Europa.
- **Rigoroso:** países da Ásia, Rússia e países árabes. Singapura deve estar explicitamente coberta.
- **Desconhecido/sem país:** aplicar o perfil intermediário ou o padrão global, sem inferir uma localização.

Esta é uma extensão do classificador e de sua configuração. A edição administrativa desses perfis pela interface fica para a Fase 7; o painel atual permanece somente de observação e leitura.

## Antes de implementar

1. Leia `prompts/CONTEXTO.md`, `docs/IMPLEMENTACAO.md`, `docs/ARQUITETURA.md`, `docs/MAXMIND.md` e `docs/PAINEL-OBSERVACAO.md`.
2. Inspecione a implementação real de `src/classification/`, `src/enrichment/`, a configuração de classificação e o estado do painel. Preserve o comportamento existente para sites sem configuração específica.
3. Confirme que `event.country` contém códigos ISO 3166-1 alpha-2 em maiúsculas e que a classificação recebe o país enriquecido antes do cálculo do score.
4. Apresente um resumo do desenho antes de editar arquivos, destacando como país/perfil modifica limites e como serão resolvidos países em mais de um grupo.

## Regras iniciais

- Criar perfis nomeados configuráveis (`relaxed`, `standard`, `strict`, ou rótulos equivalentes em português) e uma associação explícita de códigos ISO para cada perfil.
- Usar listas versionadas e documentadas. Definir “países árabes” de forma explícita; como padrão inicial, usar os membros da Liga Árabe identificados por ISO alpha-2 e registrar a fonte/data da lista. Usar uma lista explícita de países europeus e de países asiáticos; não deduzir grupos por idioma, ASN, nome da organização ou texto do GeoLite.
- Resolver sobreposições pelo perfil mais rigoroso. A lista rigorosa tem precedência sobre a intermediária; esta tem precedência sobre a leve. Rússia e países árabes permanecem rigorosos mesmo que outras classificações geográficas os incluam em outra região.
- Aplicar o perfil aos limites de volume **por IP e por site**. Cada limite por janela deve ser derivado do limite-base global ou do override daquele site, multiplicado pelo fator do perfil. Evitar limites absolutos independentes por país, para manter overrides por site previsíveis.
- Começar com fatores de observação conservadores e configuráveis: Leve `1.5x`, Intermediário `1.0x`, Rigoroso `0.5x` dos limites-base. Estes fatores só ajustam quando o classificador gera sinais de score; não limitam, descartam, atrasam nem bloqueiam tráfego.
- Manter `mode: 1` como padrão. Não ativar modo 2/3, Fail2Ban, firewall, rate limiting no Nginx ou qualquer ação de bloqueio.
- País, região ou perfil, isoladamente, não pode tornar um evento bloqueável. Preserve `minimumSignalsForBlock`, as exceções existentes e a exigência de múltiplos sinais independentes.
- Não usar geolocalização como identidade ou evidência definitiva. IPs podem estar atrás de VPN, proxy, CDN ou ter país ausente/incerto; os demais sinais do classificador continuam necessários.
- Não afrouxar limites de rotas críticas (`criticalPathPerMinute`) com o perfil Leve. Documentar se e como o perfil Rigoroso afeta essas rotas; manter limites globais seguros se não houver justificativa para alterar esse comportamento.
- Para país desconhecido, nulo, inválido ou ausente, usar o fator Intermediário/global e registrar o motivo de forma explícita apenas se isso ajudar o diagnóstico, sem penalizar o evento por ausência de país.

## Configuração e compatibilidade

- Ampliar o schema, normalização e validação em `src/classification/rules.js` para perfis, listas de países e fatores. Rejeitar códigos que não sejam ISO alpha-2, fatores fora de limites seguros e grupos inválidos.
- Atualizar `config/classification.example.json` e documentar como criar/editar o `config/classification.json` ativo. O arquivo `.example.json` não deve ser tratado como configuração carregada automaticamente.
- Preservar overrides existentes por site: o perfil geográfico deve multiplicar o limite daquele site. Não alterar silenciosamente o significado de `countries.home`, `countries.monitored` ou pesos já existentes.
- Se os pesos atuais já adicionam score por país, evitar dupla penalização automática. Explique a interação e mantenha o princípio de que localização sozinha não indica abuso.
- Falha de leitura ou configuração inválida deve manter fallback seguro, modo 1 e nenhuma ação de bloqueio, conforme o padrão atual.
- Não adicionar controles de edição ao painel de observação nesta etapa. Se útil, exibir somente o perfil/fator efetivo em detalhes de diagnóstico, sem permitir mudanças pela UI.

## Validação e aceitação

- Acrescentar testes para BR/US (Leve), países europeus (Intermediário), países asiáticos, Rússia, Singapura e países árabes (Rigoroso), sobreposição de grupos e país desconhecido.
- Testar que os limites efetivos são multiplicados por site e por janela, e que limites de rota crítica seguem a regra documentada.
- Confirmar que eventos abaixo/acima dos limites recebem os scores esperados, que localização isolada não gera elegibilidade de bloqueio e que modo 1 não executa ações.
- Testar regressão de configuração: defaults, ausência de `classification.json`, configuração atual de `sites`, overrides e erro de validação.
- Executar a suíte direcionada de classificação e a suíte completa do projeto, reportando resultados e limitações.
- Atualizar `docs/IMPLEMENTACAO.md`, `docs/ARQUITETURA.md`, `docs/PAINEL-OBSERVACAO.md` e `prompts/CONTEXTO.md` com esquema, grupos, fatores, limitações, operação e status.

## Fora do escopo

- Edição dos perfis pelo painel; pertence à Fase 7, com autenticação, autorização, validação e auditoria.
- Bloqueio automático, Fail2Ban, iptables ou rate limiting no Nginx.
- Alterações operacionais em produção ou no Nginx sem tarefa operacional específica.
- Prometer que país MaxMind corresponde à localização física do usuário.

Ao concluir, informe os arquivos alterados, grupos/códigos e fatores usados, como o limite efetivo é calculado, validações executadas e como observar o resultado sem bloquear tráfego.
