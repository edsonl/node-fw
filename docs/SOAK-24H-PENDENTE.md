# Node FW — Registro do soak de 24 horas

| Campo | Valor |
|---|---|
| Projeto | Node FW |
| Fase | 4 — Integração Nginx |
| Estado | Coletor estável; reconciliação de contagens em andamento |
| Baseline | 10/11/2026 às 11:20:50 (America/Sao_Paulo) |

## Objetivo e estado atual

Este registro valida somente o piloto Casa Doppia (`casadoppia.com.br` e `www.casadoppia.com.br`). O log tradicional dedicado está configurado apenas nesse vhost; os demais domínios ficam fora desta reconciliação. Eles continuam aparecendo nos contadores globais do Node FW.

No baseline, a API informou `collector.accepted=447962`, `collector.invalid=0`, `pipeline.writtenEvents=447962`, nenhuma falha/descarte e Redis pronto. O processo tinha iniciado em `2026-11-06T14:02:24.680Z`. Os logs PHP dedicados somavam 101 linhas.

O período de 24 horas termina a partir de **11/11/2026 às 11:20:50 (America/Sao_Paulo)**. A estabilidade operacional anterior é evidência útil, mas a reconciliação deve usar os deltas desta janela, pois o log PHP dedicado começou a ser contado no baseline.

## O que executar no servidor ao final da janela

Execute no servidor, após o horário final, e anexe ou copie o conteúdo de `/home/web/node-fw/soak-final.txt`:

```bash
cd /home/web/node-fw
{
  echo "Fim: $(date -Is)"
  echo "=== Estado do coletor e pipeline ==="
  curl -sS --max-time 5 http://127.0.0.1:8088/api/stats
  echo
  echo "=== Linhas no log PHP dedicado do Casa Doppia ==="
  zcat -f /var/log/nginx/casadoppia-php.log* 2>/dev/null | wc -l
  echo "=== Eventos do Casa Doppia retidos no stream desde o início ==="
  python3 - <<'PY'
import datetime, re, subprocess

start = datetime.datetime.fromisoformat('2026-11-10T11:20:50-03:00').timestamp()
end = datetime.datetime.now().astimezone().timestamp()
hosts = {'casadoppia.com.br', 'www.casadoppia.com.br'}
key = 'nodfw:v1:events'

def read_stream(*args):
    result = subprocess.run(
        ['redis-cli', '-n', '7', '--raw', *args],
        capture_output=True, text=True, check=True
    )
    return result.stdout.splitlines()

def entries(lines):
    result, current, i = [], None, 0
    while i < len(lines):
        if re.fullmatch(r'\d+-\d+', lines[i]):
            if current is not None:
                result.append(current)
            current = {'id': lines[i], 'fields': {}}
            i += 1
        elif current is not None and i + 1 < len(lines):
            current['fields'][lines[i]] = lines[i + 1]
            i += 2
        else:
            i += 1
    if current is not None:
        result.append(current)
    return result

oldest = entries(read_stream('XRANGE', key, '-', '+', 'COUNT', '1'))
if not oldest:
    print('Stream vazio; não há contagem Node FW para comparar.')
else:
    oldest_fields = oldest[0]['fields']
    oldest_time = datetime.datetime.fromisoformat(oldest_fields['timestamp']).timestamp()
    complete = oldest_time <= start
    since_id = f'{int(start * 1000)}-0'
    data = entries(read_stream('XRANGE', key, since_id, '+'))
    count = 0
    for entry in data:
        fields = entry['fields']
        try:
            event_time = datetime.datetime.fromisoformat(fields['timestamp']).timestamp()
        except (KeyError, ValueError):
            continue
        if start <= event_time <= end and fields.get('site') in hosts:
            count += 1
    print('Eventos do Casa Doppia no stream:', count)
    print('Evento mais antigo retido:', oldest_fields.get('timestamp', 'indisponível'))
    print('Cobertura integral desde o baseline:', 'sim' if complete else 'não; o stream já descartou parte do período')
PY
} > /home/web/node-fw/soak-final.txt 2>&1
cat /home/web/node-fw/soak-final.txt
```

O padrão `casadoppia-php.log*` inclui o arquivo atual e os logs rotacionados/comprimidos desse vhost. O contador Node FW filtra os hosts `casadoppia.com.br` e `www.casadoppia.com.br` no stream. O comando informa se o evento mais antigo ainda retido permite cobrir o baseline.

## Como avaliar

1. `collector.accepted` é global e inclui os outros domínios; não o compare diretamente com o log apenas do Casa Doppia.
2. Calcule `linhas Nginx = total final - 101`. Compare esse delta com `Eventos do Casa Doppia no stream` somente se a cobertura integral estiver como `sim`.
3. Se a cobertura estiver incompleta, a reconciliação exata de 24 horas não é possível com o stream atual. A limitação é `MAXLEN ~ 50.000`; registre a estabilidade operacional, mas deixe a comparação de contagens pendente até haver captura específica por site durante a janela.
4. Revise também `collector.invalid`, `pipeline.failedEvents`, `pipeline.writeFailures`, `pipeline.queue.droppedTotal`, `redis.ready` e os erros em `logs/node-fw-soak.log` e `/var/log/nginx/error.log`.

Se as contagens divergirem, primeiro confirme se o log contém somente requisições PHP do Casa Doppia e revise a rotação/retensão. Não marque a reconciliação como aprovada até explicar a diferença.

## Limite do stream de eventos

O stream Redis de eventos recentes é limitado a 50.000 entradas. O comando acima verifica a cobertura real antes de aceitar a contagem por site. Se o stream tiver descartado eventos do início da janela, não é possível reconstruir retroativamente o total de 24 horas só com o log do Casa Doppia e os contadores atuais do Node FW.
