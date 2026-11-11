# Prompt — Etapa final: validação de cobertura entre log PHP e Node FW

Implemente no Node FW uma funcionalidade de diagnóstico que compare, por site e intervalo de tempo, as requisições PHP/dinâmicas gravadas no access log dedicado do Nginx com os eventos correspondentes recebidos pelo Node FW via Syslog UDP.

O objetivo é permitir que um operador abra o painel, selecione o site e o período, acione **Validar** e veja se a cobertura é compatível, qual é a diferença entre as fontes e se os dados disponíveis permitem uma conclusão confiável. A comparação deve continuar possível depois que os eventos antigos forem removidos do stream Redis limitado a 50.000 entradas.

## Antes de implementar

1. Leia `prompts/CONTEXTO.md` e os documentos atuais em `docs/`, principalmente `IMPLEMENTACAO.md`, `ARQUITETURA.md`, `NGINX.md` e `PAINEL-OBSERVACAO.md`.
2. Inspecione o formato de evento, a configuração Nginx versionada, o pipeline/Redis e o painel existentes. Confirme quais componentes ainda são somente de desenvolvimento e quais estão ativos em produção.
3. Apresente um plano curto de implementação, incluindo o formato do log dedicado, a forma de obter contagens duráveis do Node FW e as permissões necessárias para ler logs. Não faça alterações operacionais em produção como parte da implementação.
4. Preserve compatibilidade com a versão do Nginx e Redis documentadas no projeto. Não suponha que o log atual possa ser interpretado sem verificar seu formato.

## Requisitos funcionais

- Permitir selecionar um site cadastrado e um intervalo com início e fim explícitos. Exibir e interpretar os limites no fuso horário configurado, deixando claro o fuso usado.
- Comparar somente a mesma população: requisições PHP/dinâmicas daquele site, com os mesmos critérios de inclusão e limites temporais nos dois lados. Não comparar o total global do coletor com o log de um único site.
- Mostrar contagem do log, contagem recebida pelo Node FW, diferença absoluta e percentual, intervalo efetivamente coberto e um resultado compreensível: compatível, divergente ou inconclusivo.
- Mostrar a razão quando o resultado for inconclusivo: arquivo ausente, rotação sem cobertura, período fora da retenção dos agregados do Node FW, formato inválido, janela ainda em andamento, lacuna de coleta ou outra limitação detectável.
- Permitir executar novamente o diagnóstico para períodos passados enquanto ambos os lados mantiverem cobertura. Informar retenção disponível e o período mais antigo que pode ser validado.
- Não usar o stream `nodfw:v1:events` como fonte histórica exclusiva. Criar ou adaptar contadores duráveis por site e por intervalos temporais, atualizados no processamento dos eventos, com retenção documentada e configurável. A contagem do diagnóstico deve sobreviver a restart do processo e respeitar o limite de memória/Redis.
- Tornar a execução segura para períodos longos: leitura em streaming dos logs, limites de intervalo e tempo de execução, sem carregar arquivos inteiros na memória. Se necessário, executar como tarefa consultável pelo painel e informar progresso/estado.
- Tratar arquivos rotacionados e comprimidos somente se o formato e a política de rotação instalados puderem ser suportados com segurança. Detectar lacunas, duplicação e arquivos indisponíveis; não apresentar uma contagem parcial como exata.
- Proteger a leitura de arquivos: caminhos definidos por configuração confiável por site, sem caminho arbitrário vindo da API/UI, sem traversal ou symlink não autorizado, acesso mínimo do usuário de serviço e sem exibir conteúdo bruto dos logs no painel.

## Integração com Nginx

- Documentar uma configuração por location PHP que preserve o access log tradicional existente e envie o evento de segurança para Syslog UDP. Quando necessário, usar destinos `access_log` separados para a mesma requisição, mantendo os formatos apropriados a cada destino.
- Para o log usado na contagem, definir um formato dedicado, estável e parseável (preferencialmente JSON com escape correto), contendo timestamp, site e um identificador suficiente para aplicar exatamente os critérios do evento Node FW. Não incluir query string, cookies, `Authorization`, corpo ou segredos.
- Não desativar nem substituir silenciosamente os logs tradicionais existentes. Explicar herança de `access_log`, locations PHP, reescritas internas e como evitar dupla contagem.
- Fornecer exemplo, validação com `nginx -t`, plano de rollback e instruções de rotação/permissões. Não editar nem recarregar Nginx de produção sem uma tarefa operacional específica e autorização explícita.

## Painel e API

- Integrar a validação ao painel existente de forma coerente com seu estágio atual. Se ele ainda for somente de leitura/loopback, manter essa restrição; não adicionar ações administrativas ou expor a UI à Internet.
- Validar site, timestamps, duração máxima e limites no servidor. Não aceitar caminhos de arquivo ou comandos fornecidos pelo cliente.
- Exibir os dois totais, delta, cobertura, status/limitações, horário da execução e configuração de retenção. Não declarar sucesso quando a cobertura for incompleta.
- Evitar consultas Redis sem limite (`KEYS`) e proteger a aplicação contra leituras concorrentes pesadas.
- Não registrar IPs, User-Agent, conteúdo do log ou dados sensíveis desnecessários para produzir o diagnóstico.

## Critérios de aceitação

- Um teste de integração com fixtures de logs e eventos conhecidos produz contagens iguais para períodos totalmente cobertos.
- Testes cobrem diferenças intencionais, sites distintos, limites temporais/fuso horário, log vazio/ausente, arquivo rotacionado/comprimido suportado, lacunas de cobertura, retenção expirada, formato inválido e restart do processo.
- O sistema identifica quando não pode concluir e informa a causa; nunca transforma falta de dados em zero nem trata cobertura parcial como aprovação.
- A contagem Node FW é independente do limite do stream de eventos e tem retenção e custo documentados.
- A leitura do log é limitada em memória e a API não permite acesso arbitrário ao filesystem.
- Os exemplos Nginx preservam os logs tradicionais e não alteram Fail2Ban, firewall, sites ou configuração de produção.
- Atualize `docs/IMPLEMENTACAO.md`, `docs/ARQUITETURA.md`, `docs/NGINX.md`, `docs/PAINEL-OBSERVACAO.md` e `prompts/CONTEXTO.md` com decisões, configuração, retenção, limitações e procedimento operacional.

## Fora do escopo

- Aplicar bloqueios, alterar Fail2Ban/iptables ou recalibrar classificação.
- Mudar ou recarregar configuração de Nginx em produção automaticamente.
- Alegar perda de UDP com certeza absoluta quando a única evidência for uma diferença de contagem; apresentar o resultado como divergência observada e explicar fatores alternativos, como população/filtro divergente, rotação, relógio ou logs incompletos.
- Expor o painel/API publicamente ou permitir que o usuário escolha caminhos locais arbitrários.

Ao concluir, informe arquivos alterados, arquitetura escolhida, comandos de implantação manual, como executar a validação no painel, retenções aplicadas, limitações e validações realizadas.
