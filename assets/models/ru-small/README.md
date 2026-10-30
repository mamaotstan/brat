# ru-small: модель для автосинхронизации (v2)

Небольшая русская модель распознавания речи (zipformer transducer, int8, ~27 МБ) из проекта
[Vosk](https://alphacephei.com/vosk/) (alphacep), в ONNX-сборке
[k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): `sherpa-onnx-small-zipformer-ru-2024-09-18`.
Модели Vosk распространяются под лицензией Apache 2.0 — перед коммерческим использованием сверьтесь со страницей модели.

| Файл | Что это |
|---|---|
| `encoder.int8.onnx` | энкодер: звук (80 мел-фильтров, 10 мс) → кадры по 40 мс |
| `decoder.int8.onnx` | предсказатель (контекст из 2 токенов) |
| `joiner.int8.onnx` | объединяет кадр и контекст → вероятности 500 токенов |
| `tokens.json` | словарь SentencePiece (unigram): `[кусок, вес, тип]` по id; получен из `bpe.model` |

Приложение не распознаёт речь свободно: текст известен, модель лишь показывает, в каком кадре звучит
каждый токен (см. `src/sync/engine.js`, `src/sync/align.js`).
