# Runtime source-build do Codeiro

Este diretório contém o que o fork precisa em runtime: o manifesto que liga o
backend source-build do `omp update` e a série de patches que reproduz esta
branch a partir de uma tag estável do upstream.

## Como o updater decide

`omp update` só usa o caminho source-build quando existe um `codeiro-omp.json`
**ao lado do binário em execução** (`process.execPath`) e esse binário se chama
`omp` ou `codeiro-omp` — os dois nomes que a distribuição instala. A lista é
branca de propósito: um interpretador (`bun src/cli.ts`) nunca adota o
manifesto que esteja ao lado dele. Sem manifesto o updater oficial roda
inalterado — npm, bun, brew, mise e binário continuam como no upstream, e a
notificação de nova versão continua olhando os releases oficiais.

Com o manifesto:

- `omp update --check` lê `releases/latest` do `upstreamRepo` e resolve o
  `patchRef` por `git ls-remote`; as duas são leituras e nada é escrito.
- `omp update` monta um staging fora do diretório de instalação, faz checkout
  exato da tag estável, aplica a série de patches, instala dependências
  congeladas, builda o binário do host, valida o `--version` do artefato e só
  então troca o binário instalado, com backup e rollback automático.

Qualquer falha na série (arquivo ausente, série vazia, patch que não aplica)
aborta o update: nunca instala um binário oficial sem os patches.

### Quando a série muda sem mudar a versão

A versão do upstream não identifica um artefato do fork: uma série nova sobre a
mesma tag produz um binário diferente com o mesmo `--version`. Por isso o
update grava um `codeiro-omp.lock.json` ao lado do binário, com a tag upstream,
o `patchRef` e o commit resolvido dele. Numa release igual à instalada, o
updater só responde `Already up to date` quando os quatro campos batem; lock
ausente, ilegível ou divergente reconstrói sem precisar de `--force`. Se o
install estiver à frente do upstream, nada é reconstruído sem `--force`:
rebuildar ali seria downgrade.

O lock é escrito depois da troca bem-sucedida — se a troca falha, o binário
antigo e o lock que o descreve continuam coerentes. Falha ao gravar o lock só
custa uma reconstrução redundante e por isso avisa em vez de abortar.

### Instalação do fork nunca é sobrescrita pelo fluxo oficial

O desvio acima olha o binário **em execução**, mas o fluxo oficial escreve no
`omp` que o PATH resolve, que pode ser outro. Antes de instalar, o updater
oficial recusa o alvo quando há um `codeiro-omp.json` ao lado dele e manda
rodar o update pelo próprio binário do fork. Sem essa guarda um `omp update`
rodado a partir de um install oficial deixaria um binário sem patches por cima
do fork, silenciosamente, já que os dois reportam a mesma versão.

## Instalar em uma máquina

```sh
# use o nome com que este fork foi instalado: `codeiro-omp` ou `omp`
bin=$(command -v codeiro-omp || command -v omp)
install -m 0644 codeiro/codeiro-omp.json "$(dirname "$(readlink -f "$bin")")/codeiro-omp.json"
```

O manifesto precisa ficar junto do binário real: se o binário do PATH é um
symlink, `process.execPath` resolve para o alvo, e é lá que o arquivo é lido.
Um install chamado `omp` também é o alvo do fluxo oficial (`$which("omp")`), e
é dele que a guarda de sobrescrita protege.

Campos:

| campo | significado |
| --- | --- |
| `distribution` | precisa ser `codeiro-omp`; é o opt-in |
| `upstreamRepo` | `owner/name` de onde vem a tag estável |
| `patchRepo` | repositório git com a série (aceita URL ou caminho local) |
| `patchRef` | branch, tag ou commit da série |
| `patchSeries` | caminho do arquivo `series` dentro de `patchRepo` |
| `sourceRoot` | staging do build; não pode encostar no diretório de instalação |

## Pré-requisitos da máquina

O build roda o bootstrap do próprio repositório e reutiliza o addon nativo
publicado para a mesma versão; precisa de `git`, `bun` 1.3.14+ e `tar` no PATH.

## Segurança do addon nativo

O updater valida o SHA-512 do tarball publicado, rejeita entradas absolutas ou
com `..`, rejeita links e arquivos especiais antes da extração e só copia
arquivos `.node` regulares do diretório `package/`. Antes da instalação, valida
com `lstat` o `sourceRoot` e cada ancestral de `packages/natives/native`; também
rejeita symlink no arquivo final e faz a troca por arquivo temporário e
`rename` atômico. Isso protege o staging contra traversal e symlinks
preexistentes no caminho de instalação.

A proteção não cobre um processo local concorrente que troque um ancestral entre
a validação e o `rename`, nem substitui a confiança no upstream, no registry npm
e na proveniência do pacote. O MVP não faz uma auditoria independente do
conteúdo nativo.

## Manter a série

`patches/series` é uma série quilt: um patch por linha, na ordem de aplicação,
com `#` para comentário. A primeira linha `# base: <tag>` fixa a tag upstream
contra a qual a série deve ser validada. Os arquivos são resolvidos relativos
ao `series`.

Quando o upstream publica uma tag nova, o `omp update` falha se algum patch não
aplicar nela. Para regenerar:

```sh
git fetch upstream --tags
git rebase <nova-tag>            # na branch codeiro
rm -f codeiro/patches/*.patch
git format-patch <nova-tag>..codeiro -o codeiro/patches -- ':(exclude)codeiro'
printf '# base: %s\n' '<nova-tag>' > codeiro/patches/series
printf '%s\n' codeiro/patches/*.patch | sed 's#^codeiro/patches/##' >> codeiro/patches/series
```

O `:(exclude)codeiro` mantém a série fora dela mesma: sem ele cada regeneração
embute os patches anteriores no patch novo.

Confira que a série reproduz a branch a partir da tag limpa antes de publicar:

```sh
git archive <nova-tag> | tar -x -C /tmp/check
(cd /tmp/check && git apply --check /caminho/codeiro/patches/*.patch)
```

Depois de validar a série, publique a branch de desenvolvimento e crie uma
referência imutável para a combinação upstream + patches:

```sh
git push origin codeiro
git tag codeiro-omp-<versao-upstream>
git push origin codeiro-omp-<versao-upstream>
```

Para uma instalação compartilhada, provisione a tag, não a branch:

```sh
CODEIRO_OMP_PATCH_REPO=https://github.com/paulocagol/oh-my-pi.git \
CODEIRO_OMP_PATCH_REF=codeiro-omp-<versao-upstream> \
just omp-provision
```

A branch `codeiro` continua sendo o espaço de desenvolvimento; a tag publicada
é o contrato reprodutível do runtime.

## Documentação por projeto

O fork adiciona um esquema de URI interno por repositório, análogo ao `omp://`
do upstream. Um projeto que tenha `.omp/project-docs.json` na raiz do
repositório ganha `read <esquema>://`, `grep <padrão> <esquema>://` e
autocomplete, sem que o conteúdo entre no contexto inicial: o system prompt só
anuncia o esquema e manda ler o índice primeiro.

```json
{
  "version": 1,
  "scheme": "vitrine.se",
  "root": "docs",
  "description": "Documentação técnica, de produto e de operação do Vitrine.",
  "exclude": ["pen/*prompt*.md"],
  "docs": [{ "path": "index.md", "title": "Índice", "description": "Ponto de entrada." }]
}
```

Contrato:

- `version` é `1`; `scheme` casa `^[a-z][a-z0-9+.-]*$`, no máximo 64 bytes, e
  `file`, `http`, `https` e `conflict` são reservados. Colisão com um handler já
  registrado descarta o catálogo em vez de sobrescrevê-lo.
- `root` é relativo à raiz do repositório e precisa resolver, por `realpath`,
  para dentro dela. O índice é o walk do `root`, não a lista `docs`.
- Arquivos que não terminam em `.md` são ignorados no walk e continuam
  inalcançáveis pelo esquema: uma raiz de documentação pode carregar as imagens
  e fontes de design que seus Markdown referenciam.
- `exclude` são globs relativos ao `root` que tiram arquivos do índice e do
  autocomplete. É **curadoria, não controle de acesso**: o documento excluído
  continua legível pelo esquema e pelo `read` comum. A fronteira de segurança é
  a contenção por `realpath`, que rejeita symlink para fora, `..`, caminho
  absoluto e percent-encoding malformado.
- `docs` é metadado opcional (título e descrição) para entradas do índice.
  Apontar para arquivo inexistente, para arquivo excluído ou para algo fora do
  `root` invalida o manifesto inteiro — falha fechada, com aviso no stderr.
- O registro é refeito quando o `cwd` muda (CLI, SDK, ciclo de vida e modo
  interativo), e nenhum corpo de documento é cacheado.
