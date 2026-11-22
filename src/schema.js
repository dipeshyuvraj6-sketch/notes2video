module.exports = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['meta', 'scenes'],
  properties: {
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'width', 'height', 'fps'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        width: { type: 'integer', const: 1920 },
        height: { type: 'integer', const: 1080 },
        fps: { type: 'integer', enum: [24, 30] }
      }
    },
    scenes: {
      type: 'array',
      minItems: 3,
      maxItems: 120,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'duration', 'background', 'elements'],
        properties: {
          id: { type: 'string', pattern: '^s[0-9]{1,3}$' },
          role: { type: 'string', enum: ['intro', 'section_title', 'explanation', 'example', 'summary'] },
          duration: { type: 'number', minimum: 4, maximum: 12 },
          background: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          transition: { type: 'string', enum: ['none', 'fade', 'slide_left', 'slide_up', 'zoom'] },
          elements: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'text', 'x', 'y', 'fontSize', 'color'],
              properties: {
                type: { type: 'string', const: 'text' },
                style: { type: 'string', enum: ['title', 'subtitle', 'body', 'caption'] },
                text: { type: 'string', minLength: 1, maxLength: 90 },
                x: { type: 'integer', minimum: 120, maximum: 1800 },
                y: { type: 'integer', minimum: 100, maximum: 980 },
                fontSize: { type: 'integer', minimum: 28, maximum: 96 },
                color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
                align: { type: 'string', enum: ['left', 'center', 'right'] },
                bold: { type: 'boolean' },
                appearAt: { type: 'number', minimum: 0 }
              }
            }
          }
        }
      }
    }
  }
};
