# Conty — desafio 08: revisão de vídeo

API que aprova uma entrega somente quando a **versão atual de cada peça exigida pela campanha** está aprovada. Mantém versões independentes de roteiro, vídeo, capa e legenda, comentários por versão e histórico de aprovação/invalidação.

Contrato: [enunciado do desafio 08](https://challenge.appconty.com/desafios/revisao-video). Esta implementação é um repositório próprio; não há base oficial reutilizada.

## Rodar

Requer **Node 22.23.3** e npm. A versão está em `.nvmrc` e na CI. No Windows, use `npm.cmd` no lugar de `npm` se a política do PowerShell bloquear `npm.ps1`.

```sh
npm ci
npm run check
npm run build
npm start
```

`check` executa typecheck, testes e smoke HTTP. `smoke` compila e inicia o servidor real em uma porta livre, faz 20 requests via TCP e encerra o processo. Usa banco em memória isolado; não precisa iniciar outro servidor.

`npm start` escuta em `http://127.0.0.1:3000` e cria `data/reviews.sqlite`. `npm run dev` usa TS com recarga. `PORT` e `DB_PATH` podem ser alterados no ambiente do processo; `DB_PATH=:memory:` elimina a persistência. O caminho de arquivo é relativo ao diretório onde o comando é executado.

O módulo nativo [node:sqlite no Node 22](https://nodejs.org/download/release/v22.23.0/docs/api/sqlite.html) ainda emite aviso experimental; não usa pacote SQLite nem compilação de addon nativo.

## Regras implementadas

- `campaign.required_pieces` é um array persistido de `script`, `video`, `cover`, `caption`. A campanha exige ao menos uma peça, sem repetição; recusar lista vazia é uma decisão desta API.
- Cada par entrega/peça começa em versão 1. A versão de maior número é atual; as anteriores, revisões e comentários permanecem consultáveis.
- Versões começam em `pending`; revisão específica muda para `approved` ou `changes_requested`. O histórico de decisões fica em `reviews`, com data. Revisões podem mudar; não há estado terminal importado do desafio de roteiro.
- Aprovar a entrega consulta somente as peças exigidas e suas versões atuais. Ausência, `pending` ou `changes_requested` retorna **409**, código e lista de pendências. Uma versão histórica aprovada não satisfaz o gate.
- Aprovar versões não aprova a entrega automaticamente: é preciso chamar `/approve`. Repetir essa chamada em uma entrega já aprovada conserva o mesmo registro.
- Aprovação guarda data e snapshot dos IDs obrigatórios aprovados. A leitura confere esse registro contra as versões atuais e seus estados. Não existe booleano persistido usado sozinho como fonte de verdade.
- Qualquer versão nova invalida a aprovação ativa, guarda data, motivo `new_version` e ID da versão causadora. A nova versão começa pendente.
- Se a revisão da versão atual obrigatória mudar para `changes_requested`, a aprovação também é invalidada, com motivo `review_changed`. Revisar versão histórica ou opcional não bloqueia o gate.
- Comentário de vídeo exige segundo numérico, finito e não negativo; aceita frações como `12.5` e o segundo `0`. O vínculo com a versão é imutável. Peças sem tempo aceitam comentário sem `timestamp_seconds`; a resposta traz `null`.
- URL HTTP/HTTPS representa o arquivo. A API não baixa nem verifica o conteúdo da URL.

### Ambiguidade: nova versão opcional

O enunciado diz que nova versão em “uma peça” desfaz a aprovação e que peça não pedida não bloqueia. A decisão própria adotada é invalidar a aprovação anterior quando **qualquer** peça recebe nova versão, inclusive opcional. A chamada seguinte de aprovação continua consultando **somente `required_pieces`**.

Exemplo: campanha exige apenas vídeo; vídeo V1 aprovado e entrega aprovada. Criar capa opcional V1 deixa a entrega em produção e registra a invalidação. Uma nova chamada de `/approve` pode aprovar a entrega imediatamente, mesmo com a capa pendente. Não se criou uma exigência de capa. Esse caso tem teste específico e também aparece no smoke HTTP.

Por isso `pending_pieces: []` pode coexistir com `approved: false`: o gate está pronto, mas a aprovação foi invalidada ou ainda não foi solicitada. Esta leitura da ambiguidade é uma decisão de implementação, não um esclarecimento oficial.

## API

Todos os corpos são JSON. Datas são ISO 8601 em UTC. IDs são UUIDs gerados pelo servidor. Listas de versões estão em ordem crescente; revisões, comentários e aprovações seguem a ordem de gravação, mesmo quando as datas empatam.

| Método e rota | Corpo | Resposta |
| --- | --- | --- |
| `GET /health` | — | 200: `{ "status": "ok" }` |
| `POST /campaigns` | `{ "name": "Verão", "required_pieces": ["video", "caption"] }` | 201: campanha |
| `GET /campaigns/:id` | — | 200: campanha |
| `POST /campaigns/:id/deliveries` | — | 201: entrega em produção |
| `POST /deliveries/:id/pieces/:piece/versions` | `{ "asset_url": "https://example.test/v1.mp4" }` | 201: versão, reviews e comments |
| `GET /piece-versions/:id` | — | 200: versão com revisões e comentários |
| `POST /piece-versions/:id/review` | `{ "decision": "approved" }` ou `changes_requested` | 200: versão revisada |
| `POST /piece-versions/:id/comments` | `{ "body": "Cortar pausa", "timestamp_seconds": 12.5 }` | 201: comentário |
| `POST /deliveries/:id/approve` | — | 200: entrega aprovada; 409: pendências |
| `GET /deliveries/:id` | — | 200: entrega, peças atuais, histórico e aprovações |

Na entrega, cada item de `pieces` contém `required`, `current_version_id` e `versions`. Cada versão inclui `status`, `created_at`, `reviewed_at`, `reviews` e `comments`. `approvals` preserva a data e o snapshot de cada aprovação, inclusive registros invalidados.

Trecho de erro ao aprovar vídeo sem a legenda obrigatória:

```json
{
  "error": {
    "code": "REQUIRED_PIECES_NOT_APPROVED",
    "message": "Entrega não aprovada: faltam versões atuais aprovadas das peças obrigatórias.",
    "pending_pieces": [
      { "piece": "caption", "reason": "missing", "current_version_id": null }
    ]
  }
}
```

`reason` também pode ser `pending` ou `changes_requested`, com o ID da versão atual. Entradas inválidas retornam 400; recursos/rotas inexistentes, 404. `name`, `asset_url` e `body` não aceitam texto vazio e têm limites de 200, 2048 e 5000 caracteres. Peças desconhecidas, peças repetidas, URL sem HTTP/HTTPS, decisão inválida e timestamp inválido são recusados.

## Exemplo completo em PowerShell

Com `npm start` rodando em outro terminal na porta padrão, copie este fluxo. As URLs de arquivos são fictícias e não precisam existir.

```powershell
$api = 'http://127.0.0.1:3000'
function Send-Json {
  param([string]$Path, [object]$Body)
  $params = @{ Uri = "$api$Path"; Method = 'Post'; ContentType = 'application/json' }
  if ($null -ne $Body) { $params.Body = ConvertTo-Json -InputObject $Body -Depth 10 }
  Invoke-RestMethod @params
}

$campaign = Send-Json '/campaigns' @{ name = 'Verão'; required_pieces = @('video', 'caption') }
$delivery = Send-Json "/campaigns/$($campaign.id)/deliveries"
$video1 = Send-Json "/deliveries/$($delivery.id)/pieces/video/versions" @{ asset_url = 'https://example.test/v1.mp4' }
$comment = Send-Json "/piece-versions/$($video1.id)/comments" @{ body = 'Cortar esta pausa'; timestamp_seconds = 12.5 }
Send-Json "/piece-versions/$($video1.id)/review" @{ decision = 'approved' } | Out-Null

# 409: caption missing; o vídeo sozinho não libera a entrega.
try { Send-Json "/deliveries/$($delivery.id)/approve" }
catch { $_.ErrorDetails.Message }

$caption = Send-Json "/deliveries/$($delivery.id)/pieces/caption/versions" @{ asset_url = 'https://example.test/caption.txt' }
Send-Json "/piece-versions/$($caption.id)/review" @{ decision = 'approved' } | Out-Null
Send-Json "/deliveries/$($delivery.id)/approve" | Select-Object status, approved
# status=approved, approved=True

$video2 = Send-Json "/deliveries/$($delivery.id)/pieces/video/versions" @{ asset_url = 'https://example.test/v2.mp4' }
Invoke-RestMethod "$api/deliveries/$($delivery.id)" | Select-Object status, approved, pending_pieces
# in_production, False, video pending
$old = Invoke-RestMethod "$api/piece-versions/$($video1.id)"
$current = Invoke-RestMethod "$api/piece-versions/$($video2.id)"
$old.comments | Select-Object piece_version_id, timestamp_seconds, body
$current.comments.Count
# comentário 12.5s na V1; V2 tem 0 comentários.

Send-Json "/piece-versions/$($video2.id)/review" @{ decision = 'approved' } | Out-Null
Send-Json "/deliveries/$($delivery.id)/approve" | Select-Object status, approved

# Uma versão de capa opcional invalida o registro, mas não cria requisito.
$cover = Send-Json "/deliveries/$($delivery.id)/pieces/cover/versions" @{ asset_url = 'https://example.test/cover.jpg' }
Invoke-RestMethod "$api/deliveries/$($delivery.id)" | Select-Object approved, pending_pieces, approvals
# approved=False; pending_pieces vazio; aprovação anterior invalidada pela capa.
Send-Json "/deliveries/$($delivery.id)/approve" | Select-Object status, approved
# approved=True, mesmo sem aprovar a capa.
```

## Persistência, transações e testes

`src/store.ts` concentra a regra de domínio e os comandos SQL. `src/app.ts` valida o contrato HTTP. `src/server.ts` inicia o adaptador Node do Hono. SQLite usa tabelas `STRICT`, chaves estrangeiras, WAL e espera de lock de 5 segundos.

Criação de versão, revisão, comentário e aprovação usam transação síncrona `BEGIN IMMEDIATE`, sem await dentro dela. O cálculo do próximo número e a invalidação são gravados juntos. A restrição `UNIQUE(delivery_id, piece, version)` impede colisão e o índice parcial permite somente uma aprovação ativa por entrega. Leituras da entrega/versão usam uma transação de leitura para retornar um snapshot consistente entre processos.

A suíte tem **34 testes**, cobrindo:

- Lista de peças como dado, incluindo campanhas somente de vídeo e vídeo+legenda; pendências claras e opcional pendente/rejeitada.
- Versão atual, histórico preservado, peças/entregas com numeração independente e aprovação histórica insuficiente.
- Invalidação por versão obrigatória e opcional; reaprovação; revisão alterada; repetição de aprovação.
- Comentário na V1 a 12.5s que não migra para V2; zero, negativos, ausentes, texto, NaN, infinito e overflow JSON.
- Entradas inválidas, 404, rollback e conexão utilizável após falha.
- Banco reaberto preservando versões, revisões, comentários e aprovação/invalidação.
- **4 processos Node concorrentes**, iniciados por barreira, criando **48 novas versões** na mesma entrega/peça sem repetir números nem perder histórico. A versão 1 anterior também permanece.

O smoke faz **20 requests HTTP reais** no build de produção, exercitando aprovação com peça faltante, V1→V2, comentários históricos e invalidação opcional/reaprovação. A CI executa `npm ci` e `npm run check` no Node 22.23.3.

## Limites e próximos passos

Não há frontend, player, processamento de vídeo, upload, autenticação, autorização por marca/criador nem pagamento. Não validamos timestamp contra duração porque não recebemos duração nem arquivo real. O histórico é retornado inteiro; SQLite síncrono atende esta demonstração, sem promessa de escala ou latência de produção. A API escuta apenas em loopback.

Com mais tempo, adicionaria permissões, paginação do histórico, limites de corpo HTTP, versionamento de migrações e testes de carga. Essas opções não mudariam a regra de aprovação das peças atuais.

## Uso de IA e revisão

O Codex gerou a implementação, os testes, o smoke, a CI e este README a partir do enunciado e das decisões de implementação descritas aqui. A revisão automatizada examinou regras de aprovação, transações, histórico, validação HTTP e coerência dos exemplos. Revisores independentes de IA trabalharam em leitura. Marco ainda não realizou revisão humana.

Foram executados em Node 22.23.3: instalação limpa (`npm ci`), typecheck, 34 testes, build, smoke com 20 requests HTTP reais e o exemplo PowerShell completo acima. A validação inclui banco em arquivo reaberto e concorrência entre quatro processos; as URLs são demonstrativas. Aprovação da plataforma e revisão humana não são resultados destes testes.
