# Rebase da série de patches

Receita operacional para quando `omp update` não consegue se atualizar
sozinho, ou quando o upstream publica uma tag nova e a série precisa ser
recalculada em cima dela. Não depende de nada específico de uma máquina: só
do checkout deste repositório, `git`, `bun` ≥1.3.14 (`packages/coding-agent/package.json:87`)
e nada além disso: o addon nativo vem do pacote publicado da tag (seção 5), então
só é preciso um toolchain Rust se o fork passar a alterar `packages/natives`.

Dentro do agente, o executor desta receita é o comando `/omp-update`: ele faz o
diagnóstico, tenta o caminho curto, rebaseia a série resolvendo cada conflito,
publica série e tag, e chama o próprio `omp update` para instalar. O banner de
release nova e o relatório de conflito apontam para ele, porque `omp update` cru
não pode produzir a release antes do rebase. Esta doc é o procedimento; o comando
é quem o executa.

## 1. Quando usar

Dois gatilhos, ambos legítimos:

- **`omp update` abortou.** A série não aplicou limpa contra a tag alvo — o
  updater nunca troca o binário instalado sem os patches aplicados
  (`codeiro/README.md:26-27`).
- **Há tag nova no upstream** e a série ainda está fixada na tag anterior. O
  header `# base: <tag>` no topo de `codeiro/patches/series` (hoje
  `# base: v17.2.15`, `codeiro/patches/series:1`) é a tag contra a qual a
  série é validada; uma tag nova do upstream não avança essa referência
  sozinha.

## 2. O que o updater já resolve sozinho

`omp update` aplica a série com `git apply` de 3 vias quando o apply direto
falha, e absorve drift mecânico — contexto que mudou de linha, espaçamento,
reordenação de hunks — sem intervenção. Cada patch que só aplicou por causa do
merge de 3 vias entra como **curado** no relatório final do updater
(estrutura `SeriesApplyReport`, campo `healed`, em
`packages/coding-agent/src/cli/codeiro-source-update.ts`); se o seu patch
aparece na lista de curados, **não há trabalho manual para ele** — a série já
está coerente com a tag nova para aquele patch, mesmo que o texto do diff
tenha mudado.

O que resta para este documento é exatamente o que a cura automática não
resolve: um patch cujo apply de 3 vias também falhou. O updater devolve esse
caso como `SeriesApplyReport.conflict`, um `PatchConflict` com o nome do
patch, a posição na série, os arquivos tocados, se todos são documentação
(`docOnly`) e a saída crua do git (`detail`) — é esse objeto que orienta as
seções 3–4 abaixo.

## 3. Sequência do rebase

Rodar a partir da raiz do checkout, na branch `codeiro`, com a árvore de
trabalho limpa (`git status --short` vazio).

1. **Buscar a tag nova.**
   ```sh
   git fetch upstream --tags
   ```
   Deu certo quando `git tag --list '<padrão-da-tag-nova>'` mostra a tag.

2. **Rebasear a branch de desenvolvimento sobre ela.**
   ```sh
   git rebase <nova-tag>
   ```
   (`codeiro/README.md:110`.) Deu certo quando o rebase termina sem `git
   rebase --abort` necessário. Conflitos aqui são conflitos de **código-fonte
   do fork contra o upstream**, resolvidos como qualquer rebase — não confundir
   com a etapa 4, que é sobre patches que não aplicam na tag base.

3. **Regenerar os arquivos de patch.**
   ```sh
   rm -f codeiro/patches/*.patch
   git format-patch <nova-tag>..codeiro -o codeiro/patches -- ':(exclude)codeiro'
   printf '# base: %s\n' '<nova-tag>' > codeiro/patches/series
   printf '%s\n' codeiro/patches/*.patch | sed 's#^codeiro/patches/##' >> codeiro/patches/series
   ```
   (`codeiro/README.md:111-114`.) O `:(exclude)codeiro` é obrigatório: sem
   ele, cada regeneração embute os patches da rodada anterior dentro do patch
   novo (`codeiro/README.md:117-118`). Deu certo quando
   `codeiro/patches/series` lista um patch por commit do intervalo, na ordem,
   e o header `# base:` aponta para `<nova-tag>`.

4. **Validar a série em árvore limpa**, exatamente como o CI faz
   (`.github/workflows/codeiro-patch-series.yml:38-46`). A série é **ordenada**:
   cada patch aplica sobre o resultado do anterior. Validar todos numa só chamada
   de `git apply --check` não valida nada — o segundo patch é conferido contra a
   árvore crua e falha com `No such file or directory` mesmo numa série válida.

   ```sh
   base="$(sed -n 's/^# base: //p' codeiro/patches/series)"
   staging="$(mktemp -d)"
   git archive "${base}" | tar -x -C "${staging}"
   while IFS= read -r patch || [ -n "${patch}" ]; do
       case "${patch}" in ""|\#*) continue ;; esac
       git -C "${staging}" apply --check "${PWD}/codeiro/patches/${patch}"
       git -C "${staging}" apply "${PWD}/codeiro/patches/${patch}"
   done < codeiro/patches/series
   ```

   Deu certo quando o laço termina sem imprimir nada. Cada falha aqui é um
   `PatchConflict` — vá para a seção 4.

## 4. Classificação de conflito

Para cada `PatchConflict` que sobrar depois da cura automática (seção 2),
decida entre dois caminhos usando o campo `files` do conflito:

- **`docOnly: true` (todo arquivo tocado é `CHANGELOG.md` ou outro
  `*.md`)** — drift de documentação, não de código. O upstream reescreveu o
  changelog dele nas mesmas linhas onde o fork inseria uma entrada; descarte
  o hunk do patch para esse arquivo (`git apply` parcial, ou editar o `.patch`
  removendo o trecho que não aplica) e refaça o `git format-patch` daquele
  commit se preferir regenerar em vez de editar à mão.
  **Se o descarte deixar o diff do patch vazio, o patch inteiro sai da
  série** — não deve virar uma entrada em `codeiro/patches/series` que aplica
  um patch sem conteúdo. Remova o arquivo `.patch` e a linha correspondente
  em `series`.
- **Qualquer arquivo fora de `*.md` no conflito** — conflito de código. Leia
  as duas versões: o hunk do patch (`detail` do `PatchConflict`, ou o próprio
  arquivo `.patch`) contra o estado atual do arquivo na tag nova, e reescreva
  o patch para expressar a mesma intenção sobre o código novo. Depois de
  editar, volte à etapa 4 da seção 3 e revalide a série inteira — um patch
  editado manualmente pode ter deslocado o contexto dos patches seguintes.

### Não reintroduza o changelog do upstream

Medido em 2026-08-13 contra a tag `v17.3.0`: dos 8 patches que falhavam no apply
direto, **6 eram só drift do `CHANGELOG.md`** — 18 linhas de release notes em 6
patches, contra 7.306 linhas de conteúdo na série. O apply de 3 vias cura 5
deles automaticamente, então isso já não trava mais o `omp update`; mas o custo
reaparece a cada release e o merge automático empilha entradas nossas dentro do
changelog deles.

A regra, portanto, é preventiva: **um commit do fork não edita
`CHANGELOG.md` do upstream.** As mudanças do fork são descritas na mensagem do
commit, na mensagem da tag da série e nos ADRs do Codeiro — três lugares que o
upstream nunca reescreve. Ao resolver um conflito de changelog nesta seção,
descarte o hunk em vez de reconciliá-lo: a série fica sem ele para sempre.

## 5. Gates obrigatórios antes de publicar

Nenhum dos três é opcional; todos são checáveis localmente antes do push.

1. **Série idêntica à branch.** A validação da etapa 4 da seção 3
   (`git archive <nova-tag> | tar -x` seguido de `git apply --check`) é a
   mesma regra que `.github/workflows/codeiro-patch-series.yml:38-45` roda no
   CI a cada push em `codeiro`: a árvore reconstruída a partir da tag base
   mais a série precisa bater com a branch fora de `codeiro/`. Rodar antes do
   push evita descobrir a divergência só depois que o CI falhar.

2. **Testes e check do pacote tocado.** Para o updater em si:
   ```sh
   cd packages/coding-agent
   bun test test/codeiro-source-update.test.ts
   bun run check
   ```
   (`bun test` roda o runner nativo do Bun sobre o arquivo, como o próprio
   `test/codeiro-source-update.test.ts:1` importa de `bun:test`; `check` é
   `biome check . && bun run check:types`, `packages/coding-agent/package.json:35-36`.)
   Se o rebase tocou outro pacote do workspace, rode a suíte inteira: um teste do
   fork que vazava `chdir` derrubou 40 testes alheios que passavam isolados, e só
   a suíte completa mostra isso.

3. **Addon nativo da tag nova, sempre.** O `.node` em
   `packages/natives/native/pi_natives.<plataforma>.node` **não é versionado**
   (`git ls-files packages/natives/native` só lista `.js`/`.d.ts`): o rebase o
   deixa na versão da tag anterior e o `build` o embute. O loader
   (`packages/natives/native/loader-state.js`) exige o símbolo
   `__piNativesV<versão>` derivado de `packages/natives/package.json`, então o
   binário morre com `Failed to load pi_natives native addon for ...`. Pior: o
   binário extrai o addon embutido por cima do cache compartilhado
   `~/.omp/natives/<versão>/`, quebrando também o `omp` upstream instalado — e
   "limpar o cache e rodar de novo" o reenvenena.

   Diagnóstico e correção, sem toolchain Rust — o fork não altera código nativo,
   então o addon publicado da tag é o correto (é o mesmo que
   `installPublishedNativeAddon` busca no source-build):
   ```sh
   strings -a packages/natives/native/pi_natives.darwin-arm64.node \
     | grep -o '__piNativesV[0-9_]*' | sort -u            # versão embutida hoje
   grep -o '"version": "[^"]*"' packages/natives/package.json | head -1

   bun install --frozen-lockfile                          # traz o pacote da tag
   cp ~/.cache/.bun/install/cache/@oh-my-pi/pi-natives-<plataforma>@<versão>@@@1/pi_natives.<plataforma>.node \
      packages/natives/native/
   ```
   `bun run build:native` (alias de `bun --cwd=packages/natives run build`) só é
   necessário quando o fork passar a alterar `packages/natives` de verdade.
   Depois de rodar o binário novo, confirme que o cache compartilhado voltou a
   ser genuíno: `strings -a ~/.omp/natives/<versão>/pi_natives.<plataforma>.node
   | grep -o '__piNativesV[0-9_]*'`.

## 6. Publicação

Depois que os três gates da seção 5 passarem:

```sh
git push origin codeiro
git tag codeiro-omp-<versao-upstream>
git push origin codeiro-omp-<versao-upstream>
```

(`codeiro/README.md:131-134`.) A branch `codeiro` continua sendo o espaço de
desenvolvimento; a tag é o contrato reprodutível — instalação compartilhada
aponta `CODEIRO_OMP_PATCH_REF` para a tag, não para a branch
(`codeiro/README.md:139-145`), porque a branch pode ganhar commits novos a
qualquer momento e a tag, não: uma referência imutável é o que permite a
todo `omp update` de todo install resolver exatamente a mesma série para a
mesma versão upstream, em vez de uma janela de corrida contra o próximo push.

## 7. Veredito

O ciclo termina com um dos dois relatos abaixo, nunca em silêncio:

- **Atualizado.** Upstream `<tag>`, série `codeiro-omp-<versao-upstream>`
  (ou a branch `codeiro` no commit `<sha>`, se ainda não houver tag), número
  de patches aplicados sobre o total, e a lista dos que só entraram por cura
  automática (`SeriesApplyReport.healed`) — para quem revisar depois saber
  que aqueles não tiveram edição manual.
- **Não atualizado.** A tag/branch onde parou, quantos patches aplicaram dos
  quantos totais (`SeriesApplyReport.applied` / `.total`), e o `PatchConflict`
  exato que travou: nome do patch, posição na série, arquivos tocados,
  `docOnly` ou não, e se o apply de 3 vias já foi tentado (`threeWay`) — o
  suficiente para quem retomar ir direto para a seção 4 sem precisar
  reproduzir a falha primeiro.
