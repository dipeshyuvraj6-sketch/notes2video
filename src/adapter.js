const transitionMap = {
  fade: 'fade',
  slide_left: 'slideLeft',
  slide_up: 'slideUp',
  zoom: 'zoomIn'
};

function toKinoSchema(canonical, audioPath) {
  if (!canonical || !canonical.meta || !Array.isArray(canonical.scenes)) {
    throw new Error('Invalid canonical schema: missing meta or scenes.');
  }
  return {
    width: canonical.meta.width,
    height: canonical.meta.height,
    fps: canonical.meta.fps,
    ...(audioPath ? { audio: { src: audioPath, volume: 1, fadeIn: 0.1, fadeOut: 0.5 } } : {}),
    scenes: canonical.scenes.map((scene, index) => ({
      duration: scene.duration,
      background: scene.background,
      ...(index > 0 && scene.transition && scene.transition !== 'none'
        ? { transition: { type: transitionMap[scene.transition] || 'fade', duration: 0.5 } }
        : {}),
      elements: scene.elements.map((element) => ({
        type: 'text',
        content: element.text,
        x: element.align === 'center' ? 'center' : element.x,
        y: element.y,
        fontSize: element.fontSize,
        fontColor: element.color,
        textAlign: element.align,
        maxWidth: 1680
      }))
    }))
  };
}

module.exports = { toKinoSchema };
