# Conversor PLT → DXF

Site estático que converte arquivos **PLT (HPGL / HPGL-2)** em **DXF**, direto no navegador.

- **Sem limite** de quantidade nem de tamanho de arquivo (processamento em streaming, com vários Web Workers em paralelo)
- **Privado**: nenhum arquivo é enviado para servidor algum
- Arraste arquivos **ou pastas inteiras**; baixe um por um, tudo em `.zip` ou salve direto em uma pasta (Chrome/Edge)
- Cada caneta (`SP1`, `SP2`…) vira uma camada (`PEN1`, `PEN2`…)
- Opção **Converter textos em linhas**: os textos (`LB`) viram desenho, sem texto editável no DXF. Estilos: formas com preenchimento sólido (cada traço vira um retângulo fechado + `SOLID`), só contorno, ou linhas simples. Espessura ajustável. As escolhas ficam salvas no navegador
- Saída DXF R12 (AC1009): abre em AutoCAD, LibreCAD, CorelDRAW, Inkscape, Audaces, etc.
- Sem dependências externas (JSZip incluído em `vendor/`)

Comandos suportados: `IN SP PU PD PA PR PE CI AA AR AT RT EA ER RA RR IP SC LB LO SI DI DR DT DF`.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub (ex.: `PLT-to-DXF`) e envie estes arquivos para a branch `main`.
2. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, pasta `/ (root)` → **Save**.
3. Em 1–2 minutos o site estará em `https://gcroquevs.github.io/PLT-to-DXF/`.

## Testar localmente

Os Web Workers não funcionam abrindo o `index.html` direto do disco (`file://`) — nesse caso
o site ainda funciona, mas converte um arquivo por vez. Para testar com paralelismo:

```bash
python3 -m http.server 8000
```

e abra http://localhost:8000.

## Resolução

Por padrão, 1 unidade HPGL = 0,025 mm (40 unidades/mm). Se o desenho sair com tamanho errado,
altere **Opções de conversão → Resolução do PLT**.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html`, `style.css` | Interface |
| `app.js` | Fila, pool de workers, downloads |
| `converter.js` | Parser HPGL + gerador DXF (funciona também no Node) |
| `worker.js` | Web Worker que roda o conversor |
| `font.js` | Fonte de traço único Hershey Simplex (textos em linhas) |
| `vendor/jszip.min.js` | Geração do `.zip` (licença MIT) |
| `vendor/hersheytext-LICENSE` | Licença dos dados da fonte (MIT) |
