# Node FW — MaxMind

| Campo | Valor |
|---|---|
| Projeto de destino | `/home/edson/www/node-fw/` |
| Projeto inspecionado | `/home/edson/node-anti-span/` |
| Tipo de inspeção | Somente leitura |
| Data da inspeção | 05/11/2026 |
| Status | Inspeção concluída; nenhum banco ou credencial copiado |
| Documento | Estratégia de dados, atualização e segurança |

## 1. Resumo

O projeto `/home/edson/node-anti-span/` utiliza MaxMind GeoLite2 para geolocalização por país. A inspeção encontrou:

- Um único banco `.mmdb`: `GeoLite2-Country.mmdb`.
- Nenhum banco `GeoLite2-ASN.mmdb` ou `GeoLite2-City.mmdb`.
- Variáveis de ambiente para edição, credenciais e idade máxima do banco.
- Download via endpoint oficial da MaxMind, com a licença passada na URL.
- Atualização na inicialização quando o banco está ausente ou vencido, e comando manual forçado.
- Banco não versionado no Git.

O Node FW precisa de **Country + ASN**. Portanto, o banco Country existente pode ser copiado, mas o ASN ainda precisa ser obtido de forma independente com a conta/licença MaxMind. Nenhum valor de credencial foi copiado, exibido ou registrado neste documento.

## 2. Inventário encontrado

| Item | Resultado |
|---|---|
| Diretório de dados | `/home/edson/node-anti-span/geolite-data/` |
| Banco disponível | `GeoLite2-Country.mmdb` |
| Caminho completo | `/home/edson/node-anti-span/geolite-data/GeoLite2-Country.mmdb` |
| Tamanho | 9.497.797 bytes (aproximadamente 9,5 MB) |
| Última modificação | 24/03/2026 08:15:12 (UTC-03:00) |
| Permissões | `0644` |
| Proprietário | `edson:edson` |
| Edições presentes | Apenas Country |
| ASN | Ausente |
| City | Ausente |
| Versionamento Git | Banco não rastreado; `.gitignore` do projeto antigo exclui `geolite-data/*.mmdb` |
| Biblioteca Node | `maxmind` `5.0.5` no projeto antigo |

Observação: o banco encontrado tem data de modificação de março de 2026. A idade real dos dados deve ser confirmada pelo metadata interno do `.mmdb` na Fase 5.

## 3. Edições disponíveis

| Edição | Disponível no projeto antigo | Necessária no Node FW | Observação |
|---|---|---|---|
| GeoLite2-Country | Sim | Sim | País e continente |
| GeoLite2-ASN | Não | Sim | Número e organização do ASN |
| GeoLite2-City | Não | Opcional | Cidade/região; não necessária para o escopo inicial |

A ausência do ASN é uma pendência. O Node FW deve verificar se a conta/licença existente tem direito a `GeoLite2-ASN`. Caso não tenha, será necessário habilitar a edição ou obter uma licença adequada.

## 4. Variáveis de ambiente encontradas

Apenas os nomes e a função foram documentados. Valores de `MAXMIND_ACCOUNT_ID` e `MAXMIND_LICENSE_KEY` são secretos e não foram reproduzidos.

| Variável | Presente no `.env` | Sensível | Função observada |
|---|---|---|---|
| `GEOIP_DB_PATH` | Sim | Não | Caminho do banco Country; no projeto antigo aponta para `geolite-data/GeoLite2-Country.mmdb` |
| `MAXMIND_EDITION_ID` | Sim | Não | Edição usada no download; valor observado: `GeoLite2-Country` |
| `MAXMIND_ACCOUNT_ID` | Sim | Sim | Identificador da conta MaxMind; valor não documentado |
| `MAXMIND_LICENSE_KEY` | Sim | Sim | Chave usada no download; valor não documentado |
| `MAXMIND_REFRESH_MAX_AGE_DAYS` | Sim | Não | Idade máxima antes de atualizar; valor observado: `3` |

O projeto antigo também possui `.env.example` com os mesmos nomes de variáveis. Nenhum arquivo `.env` deve ser copiado integralmente para o Node FW.

## 5. Download e atualização observados

### 5.1 Endpoint

O projeto antigo monta a URL em memória no seguinte formato:

```text
https://download.maxmind.com/app/geoip_download?edition_id=<EDITION_ID>&license_key=<LICENSE_KEY>&suffix=tar.gz
```

A licença é enviada como parâmetro de query. Isso exige cuidado rigoroso:

- Nunca registrar a URL completa em logs, erros, métricas ou respostas.
- Nunca expor a URL em documentação, issues ou relatórios.
- Ao relatar falhas, registrar apenas status HTTP e edição, nunca a URL.
- Não usar ferramentas de debug que imprimam a URL.

O `MAXMIND_ACCOUNT_ID` não é usado na URL observada; a autenticação do download legacy é feita pela license key. O Account ID deve ser mantido apenas se necessário para gestão ou APIs futuras.

### 5.2 Fluxo observado

O comportamento do projeto antigo foi inspecionado, mas **não será reutilizado como código**:

1. Verifica se o banco existe e se a idade em dias excede `MAXMIND_REFRESH_MAX_AGE_DAYS`.
2. Se não houver license key, ignora a atualização.
3. Baixa o arquivo `tar.gz` para um diretório temporário.
4. Extrai o conteúdo e localiza o primeiro arquivo `.mmdb`.
5. Copia o banco para um arquivo temporário no destino.
6. Substitui o destino por `rename` atômico.
7. Em caso de falha, mantém o banco existente.
8. Na inicialização, tenta atualizar se o banco estiver ausente ou vencido.
9. Há um comando manual forçado (`npm run update:maxmind` no projeto antigo).

O Node FW implementará sua própria rotina, com validações adicionais descritas na seção 8.

## 6. Estratégia de cópia segura

Esta etapa **não foi executada**. A cópia ocorrerá na Fase 5, após validação e autorização.

### 6.1 Banco Country

1. Confirmar que o projeto de origem não está em uso exclusivo ou bloqueado.
2. Criar o diretório de destino independente:
   - Desenvolvimento: `/home/edson/www/node-fw/data/geolite2/`
   - Produção: `/var/lib/node-fw/geolite2/`
3. Aplicar permissões restritas ao diretório.
4. Copiar o arquivo com `install` ou `cp` normal, nunca com link simbólico, hardlink, bind mount ou compartilhamento de arquivo.
5. Preservar o arquivo original; não mover, renomear ou alterar nada na origem.
6. Calcular SHA-256 na origem e no destino e comparar.
7. Validar o `.mmdb` com a biblioteca `maxmind` antes de ativar.
8. Registrar no manifesto: edição, build epoch, tamanho, SHA-256, data da cópia e origem. Não registrar credenciais.

Exemplo ilustrativo (executar somente na Fase 5, com os caminhos e usuário definidos):

```bash
install -d -m 0750 -o nodefw -g nodefw /var/lib/node-fw/geolite2
install -m 0640 -o nodefw -g nodefw \
  /home/edson/node-anti-span/geolite-data/GeoLite2-Country.mmdb \
  /var/lib/node-fw/geolite2/GeoLite2-Country.mmdb
sha256sum /home/edson/node-anti-span/geolite-data/GeoLite2-Country.mmdb \
          /var/lib/node-fw/geolite2/GeoLite2-Country.mmdb
```

O comando acima é apenas um modelo. A execução real deve ser revisada para o usuário de serviço e o caminho de produção.

### 6.2 Banco ASN

O ASN não existe no projeto antigo. Deve ser obtido de forma independente:

1. Verificar a titularidade da edição `GeoLite2-ASN` na conta MaxMind.
2. Baixar diretamente para o diretório do Node FW.
3. Validar o arquivo e registrar o manifesto.
4. Nunca copiar o banco de outro projeto ou criar dependência dele.

### 6.3 Credenciais

- Não copiar o `.env` antigo.
- Criar um `.env` novo no Node FW com apenas as variáveis necessárias.
- Criar o arquivo com `umask 077` e permissão final `0600`.
- Não usar `echo` com a chave em shell history; usar editor seguro ou gerenciador de segredos.
- Não colocar credenciais em `config/`, Redis, manifesto, logs ou variáveis de build do frontend.
- Confirmar que `.env` está no `.gitignore` antes de qualquer commit.
- Em produção, considerar um cofre de segredos ou `systemd` com `EnvironmentFile` restrito.

## 7. Organização futura dos arquivos

```text
node-fw/
├── data/
│   └── geolite2/
│       ├── GeoLite2-Country.mmdb
│       ├── GeoLite2-ASN.mmdb
│       └── manifest.json
├── .env                 # não versionado, 0600
├── .env.example         # apenas nomes e placeholders
└── .gitignore
```

Em produção:

```text
/var/lib/node-fw/geolite2/
├── GeoLite2-Country.mmdb
├── GeoLite2-ASN.mmdb
├── GeoLite2-Country.mmdb.previous
├── GeoLite2-ASN.mmdb.previous
└── manifest.json
```

Regras:

- O diretório do código não deve ser o local definitivo dos bancos em produção.
- Os bancos não devem ser servidos pelo Nginx.
- Não usar links simbólicos para o projeto antigo.
- O manifesto não pode conter Account ID, License Key ou URL com credenciais.
- O arquivo `.previous` serve para rollback imediato e deve ter retenção curta.

## 8. Implementação independente no Node FW

### 8.1 Dependências

- Usar a biblioteca genérica `maxmind` (npm), sem importar módulos do projeto antigo.
- Não usar `require()` com caminhos de `/home/edson/node-anti-span/`.
- Não copiar funções, classes ou arquivos do projeto antigo.
- O código do updater será novo, com testes próprios.

### 8.2 Variáveis propostas

```dotenv
MAXMIND_ACCOUNT_ID=
MAXMIND_LICENSE_KEY=
MAXMIND_EDITION_IDS=GeoLite2-Country,GeoLite2-ASN
MAXMIND_DB_DIR=./data/geolite2
MAXMIND_REFRESH_MAX_AGE_DAYS=3
MAXMIND_DOWNLOAD_TIMEOUT_MS=120000
```

- `MAXMIND_ACCOUNT_ID` e `MAXMIND_LICENSE_KEY` são secretos.
- `MAXMIND_EDITION_IDS` permite atualizar Country e ASN no mesmo job.
- O diretório de produção deve ser configurado explicitamente.
- O timeout evita conexões penduradas.

### 8.3 Leitor local

- Abrir os bancos uma vez na inicialização e manter readers em memória.
- Consultar país e ASN por IP, incluindo IPv4 e IPv6.
- Retornar `null`/desconhecido para IP privado, reservado, inválido ou não encontrado.
- Cachear resultados por IP com TTL curto para reduzir chamadas repetidas.
- Não fazer chamadas de rede no caminho de coleta.
- Recarregar os readers após uma atualização bem-sucedida, sem reiniciar o serviço.

### 8.4 Atualizador independente

Requisitos:

1. Job agendado (por exemplo, diário em horário de baixa, com jitter).
2. Verificar a idade do arquivo antes de baixar; respeitar `MAXMIND_REFRESH_MAX_AGE_DAYS`.
3. Adquirir lock distribuído no Redis (`SET NX EX`) ou lockfile para evitar execuções concorrentes.
4. Baixar cada edição para diretório temporário.
5. Extrair o `tar.gz` com proteção contra path traversal e sem preservar caminhos absolutos.
6. Localizar o `.mmdb` esperado e rejeitar arquivos inesperados.
7. Validar o banco abrindo-o com a biblioteca e lendo o metadata.
8. Calcular SHA-256 e registrar no manifesto.
9. Fazer swap atômico: gravar `.tmp`, validar, renomear para o destino e manter `.previous`.
10. Se qualquer etapa falhar, manter o banco atual e registrar erro sem credenciais.
11. Atualizar o reader em memória de forma atômica.
12. Liberar o lock em `finally`.
13. Implementar timeout, retry com backoff e limite de tentativas.
14. Não logar a URL de download; logar apenas edição, status HTTP e motivo.

### 8.5 Tratamento de erros

| Situação | Ação |
|---|---|
| Sem license key | Não atualizar; health degradado; log sem segredo |
| HTTP 401/403 | Não repetir em loop; alertar credencial inválida |
| HTTP 429 | Respeitar backoff; tentar mais tarde |
| Timeout | Abortar; manter banco atual |
| Tar inválido | Rejeitar; manter banco atual |
| `.mmdb` ausente | Rejeitar; manter banco atual |
| Banco corrompido | Rejeitar; manter banco atual e alertar |
| Disco cheio | Abortar; manter banco atual; alertar |
| Lock ocupado | Pular execução; tentar no próximo ciclo |

### 8.6 Cache e desempenho

- Cache de país/ASN por IP com TTL e limite de entradas.
- Cache de verificação de bots separado.
- Nenhuma consulta de rede no hot path.
- Atualização fora do processo de coleta ou em job com baixa prioridade.

## 9. Segurança e segredos

- `.env` com permissão `0600` e proprietário do serviço.
- Nunca imprimir `MAXMIND_ACCOUNT_ID` ou `MAXMIND_LICENSE_KEY`.
- Redigir parâmetros de query em qualquer log de HTTP client.
- Não armazenar credenciais no Redis, manifesto, banco de dados ou frontend.
- Não versionar `.env`, bancos `.mmdb`, `.previous`, `.tmp` ou manifesto local.
- `.gitignore` do Node FW já contempla:
  - `.env` e variantes;
  - `data/geolite2/*.mmdb`;
  - `data/geolite2/*.tar.gz`;
  - `data/geolite2/*.tmp`;
  - `data/geolite2/manifest.json`.
- Bancos não devem ser acessíveis por URL pública.
- O usuário do serviço deve ter apenas leitura dos bancos e escrita no diretório de atualização, se necessário.

## 10. Licença e atribuição

O GeoLite2 é fornecido pela MaxMind. O painel e a documentação do Node FW devem incluir atribuição adequada, por exemplo:

```text
This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.
```

Antes da produção, revisar os termos aplicáveis à conta e ao uso interno dos bancos. Não redistribuir os arquivos `.mmdb` publicamente.

## 11. Pendências e riscos

| Pendência | Impacto | Próxima ação |
|---|---|---|
| ASN ausente no projeto antigo | Sem dados de ASN | Confirmar direito à edição `GeoLite2-ASN` e baixar |
| Data do banco Country | Dados podem estar desatualizados | Validar build epoch na Fase 5 |
| Account ID sem uso no download observado | Pode ser necessário para outras APIs | Manter secreto e confirmar necessidade |
| Endpoint legacy com chave na URL | Risco de vazamento em logs | Redaction rigorosa e teste de logs |
| Caminho de produção indefinido | Permissões e backup | Definir `/var/lib/node-fw/geolite2/` |
| Usuário de serviço indefinido | Permissões incorretas | Definir na Fase 9 |
| Sem City | Sem detalhe de cidade | Manter opcional; não bloquear a Fase 5 |

## 12. Checklist da Fase 5

- [ ] Confirmar titularidade de Country e ASN na conta MaxMind.
- [ ] Validar metadata/build epoch do banco Country existente.
- [ ] Criar diretório independente com permissões restritas.
- [ ] Copiar Country sem link simbólico/hardlink.
- [ ] Obter ASN de forma independente.
- [ ] Calcular e comparar SHA-256.
- [ ] Criar `.env` novo com `0600`.
- [ ] Implementar leitor local e cache.
- [ ] Implementar updater independente com lock e troca atômica.
- [ ] Implementar validação antes do swap e rollback para `.previous`.
- [ ] Testar IPv4, IPv6, IP privado e IP inválido.
- [ ] Testar falhas de download, tar e banco corrompido.
- [ ] Confirmar ausência de credenciais em logs.
- [ ] Adicionar atribuição MaxMind no painel.
- [ ] Atualizar `docs/IMPLEMENTACAO.md`.

## 13. Confirmação de conformidade

Nesta execução:

- Nenhum arquivo do projeto `/home/edson/node-anti-span/` foi modificado.
- Nenhum banco `.mmdb` foi copiado.
- Nenhuma credencial foi copiada ou exibida.
- Nenhum link simbólico foi criado.
- Nenhum código do projeto antigo foi importado.
- A inspeção foi exclusivamente de leitura.
