# BREAKER — Periodic Cleanup Checklist

> **Quando:** a cada 1-2 semanas ou após mudanças grandes.
> **Como:** itere seção por seção, gere tarefas para cada item que aplicar.
> **Monorepo:** pnpm workspaces — rode tools por package, não do root.

## Regras de execução (OBRIGATÓRIO)

1. **Nunca editar strategy files** em `packages/backtest/src/strategies/` — são gerados pelo refiner e serão sobrescritos. Correções vão nos prompts ou no engine.
2. **Uma mudança por commit** — não misturar refactor + fix + feature no mesmo commit.
3. **Sempre terminar com `pnpm build && pnpm test`** — não considerar tarefa completa sem testes passando.
4. **Não remover código que PARECE morto sem confirmar** — factories são auto-discovered via `Object.keys(mod).find(k => k.startsWith("create"))`, exports podem ser usados dinamicamente. Na dúvida, grep antes de deletar.
5. **Não adicionar dependências pesadas** — `@breaker/kit` deve ser minimal. Backtest engine é hot path (~2s/run); libs que adicionam overhead lá são proibidas.
6. **Respeitar CLAUDE.md** — ler o CLAUDE.md do package antes de mexer nele. As regras lá são intencionais.

---

## 1. AI-Generated Code (Strategy Files)

- [ ] **Prompt rules atualizadas?**
  - Bugs recorrentes no output do Claude viram hard rules em `build-optimize-prompt.ts`
  - Verificar se regras existentes ainda são necessárias (regras obsoletas poluem o prompt)
  - Conferir que `CANDIDATE_SLUGS` cobre todos os candidatos do KB: test "CANDIDATE_SLUGS covers all KB candidates" em `build-module-context.test.ts`

- [ ] **Strategy files são válidos?**
  - Typecheck: `pnpm --filter @breaker/backtest typecheck`
  - Nenhum strategy file tem imports quebrados ou tipos inexistentes
  - Factory exports seguem o padrão `create{PascalCase}` auto-discovered por `run-engine-child.ts`

- [ ] **Refiner output review**
  - Ler 1-2 strategy files gerados recentemente e verificar:
    - Error handling incompleto ou genérico (catch vazio, `catch { }`)
    - Lógica duplicada entre estratégias (copiar padrões sem adaptar)
    - Parâmetros hardcoded que deveriam ser configuráveis (ou vice-versa)
    - Guards ausentes: NaN em indicadores, divisão por zero, arrays vazios
  - Se encontrar problemas recorrentes: adicionar regra em `build-optimize-prompt.ts`, não corrigir o strategy file

---

## 2. Testes

- [ ] **Cobertura de código crítico**
  - `pnpm --filter @breaker/exchange vitest run --coverage` — foco em files < 60%
  - Prioridade: qualquer arquivo que toca ordens, posições, ou dinheiro
  - `packages/exchange/src/application/` e `packages/exchange/src/domain/` são as áreas mais críticas

- [ ] **Qualidade dos testes**
  - Testes afirmam comportamento, não detalhes de implementação
  - Edge cases cobertos: valores zero, negativos, arrays vazios, boundary conditions
  - Trading-specific: partial fills, slippage, session boundaries, ordens simultâneas
  - Sem testes flaky (dependentes de tempo, ordem, ou estado externo)

- [ ] **Categorias de teste que podem faltar**
  - Unit tests para funções puras de cálculo (indicadores, scoring)
  - Integration tests para pipelines (signal → filter → entry → exit)
  - Error path tests: o que acontece quando API retorna garbage? Quando WS desconecta?
  - Strategy files NÃO devem ter testes manuais (são artefatos efêmeros)

- [ ] **Testes do refiner refletem o código?**
  - Após mudanças em stages, conferir que `orchestrator.test.ts` cobre o novo fluxo
  - Conferir `variant-manager.test.ts` — slugs e componentes estão consistentes?
  - Rodar: `pnpm --filter @breaker/refiner test` (736+ tests devem passar)

---

## 3. Documentação (.md files)

### CLAUDE.md (mais importante)

- [ ] **Root `CLAUDE.md` está atualizado?**
  - Monorepo structure reflete packages existentes
  - Naming conventions estão sendo seguidas (kebab-case, one export per file)
  - Build/test commands funcionam (`pnpm build && pnpm test`)
  - Cross-package pitfalls ainda são válidos

- [ ] **Package-level `CLAUDE.md` refletem o código?**
  - Ler cada `packages/*/CLAUDE.md` e comparar com o código atual
  - Corrigir informações desatualizadas (nomes de funções renomeadas, fluxos que mudaram, pitfalls resolvidos)
  - Packages prioritários: refiner (muda mais), exchange (mais crítico), backtest

- [ ] **Auto-memory (`~/.claude/projects/.../memory/MEMORY.md`) está limpo?**
  - Sem entradas duplicadas ou contraditórias
  - Sem informação session-specific (deveria ser apenas padrões estáveis)
  - Sem informação que contradiz CLAUDE.md files

### Knowledge Base

- [ ] **KB drift check**
  - Rodar: `/kb-drift` (skill existente)
  - Verificar se candidatos de componentes no KB match os `CANDIDATE_SLUGS`
  - Verificar se MODULE_CRITERIA (minPF, maxDD, etc.) match as tabelas do KB

### README files

- [ ] **README.md do root e packages** — instruções de setup/run ainda funcionam?

---

## 4. Arquitetura & Código

- [ ] **Dead code removal**
  - Exports não usados, tipos órfãos, variáveis mortas
  - Blocos de código comentado — remover (git tem o histórico)
  - Branches inalcançáveis ou condições impossíveis
  - Usar grep para confirmar que exports "mortos" não são usados dinamicamente antes de remover

- [ ] **Extrair utilitários duplicados para `@breaker/kit`**
  - Funções puras duplicadas entre packages (formatters, validators, math)
  - Constantes compartilhadas que vivem em arquivos aleatórios
  - `backoffDelay` é exemplo de extração bem-sucedida para kit

- [ ] **Dependências circulares**
  - Verificar imports entre packages — não deve haver ciclos
  - Build order esperada: kit ← backtest ← refiner; kit ← exchange; kit ← alerts; kit ← router

- [ ] **Libs que substituem código custom**
  - Procurar funções utilitárias implementadas manualmente que poderiam ser substituídas por libs leves e bem mantidas (>1k stars, mantido ativamente, tree-shakeable)
  - Áreas comuns: date/time helpers, string case conversion (kebab↔camel↔pascal), retry/backoff, array utilities (chunk, groupBy, unique), number formatting, CLI arg parsing, CSV parsing, deep clone/merge
  - Antes de substituir: verificar o tamanho da lib (`npx packagephobia <pkg>`), se é ESM-compatible, e se não adiciona overhead em hot paths (backtest engine)
  - Priorizar: implementações custom com >15 linhas que já têm lib equivalente battle-tested
  - Não trocar one-liners por dependências — o custo de manter a dep é maior que o código

- [ ] **Zod schemas em sync**
  - Config files validados no startup com Zod (fail-fast)
  - Novos campos adicionados no arquivo de config E no schema Zod
  - `exchange-config.json` e `breaker-config.json` — schemas match?

---

## 5. Segurança & Safety (Trading)

- [ ] **API keys / secrets**
  - `.env` contém APENAS secrets (API keys, tokens)
  - Nenhum secret em código, logs, ou git history
  - Grep por strings suspeitas: `secret`, `apikey`, `private_key`, `token` em arquivos `.ts`

- [ ] **Order safety guards**
  - Max position size enforced em código (não só config)
  - Max loss per trade / per day com hard limits
  - Rate limiting em order submission
  - Sanity check: rejeitar ordens com preço > X% do mercado

- [ ] **Input validation**
  - Dados externos (API responses, WS messages) validados com Zod
  - Preços/quantidades checados para: NaN, Infinity, negativo, zero, magnitude absurda
  - Timestamps validados (não no futuro, não stale)

- [ ] **Floating point**
  - `truncateSize()` / `truncatePrice()` aplicados antes de TODA chamada SDK
  - `Math.floor` para buys e sells (Hyperliquid `reduceOnly` rejeita se size > position)
  - Sem comparação entre valores pré e pós-truncation

- [ ] **Hyperliquid SDK**
  - `BTC-PERP` vs `BTC` — `toSymbol()` / `fromSymbol()` usados consistentemente
  - `floatToWire()` nunca chamado com valores não-truncados
  - `loadSzDecimals(coin)` chamado no startup antes de qualquer ordem
  - SDK version pinado; checar changelog em updates

---

## 6. Runtime & State

- [ ] **Race conditions**
  - Sinais concorrentes não criam ordens conflitantes
  - Estado da posição consistente entre check e placement
  - WS reconnect não perde ou duplica mensagens
  - `processPendingFill` com await previne duplicate inserts

- [ ] **Graceful shutdown**
  - SIGTERM/SIGINT handler funciona
  - Shutdown cancela ordens pendentes
  - WS connections fechadas cleanly
  - State persistido antes do exit

- [ ] **State recovery**
  - No restart, reconcilia estado local com exchange
  - Detecta posições órfãs
  - Lock files limpos após crash (`breaker-*.lock`)

---

## 7. Limpeza de Artefatos

- [ ] **Rodar `/clean` (skill existente) para ver status**
  - Checkpoints antigos acumulando? (`assets/*/checkpoints/`)
  - Variant registry com variantes obsoletas?
  - Lock files órfãos?
  - Candle databases grandes demais?

- [ ] **Dependências desatualizadas**
  - `pnpm outdated` — verificar se há updates importantes
  - Atenção especial: `hyperliquid-ts`, `xstate`, `zod`, `vitest`

