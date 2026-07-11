import React, { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

interface TextLayerProps {
  pageNum: number;
  pdfDoc: PDFDocumentProxy | null;
  scale: number;
  width: number;
  height: number;
}

interface PositionedTextItem {
  text: string;
  left: number;
  top: number;
  fontSize: number;
  scaleX: number;
}

const isTextItem = (item: TextItem | { type: string }): item is TextItem => 'str' in item;

export const TextLayer: React.FC<TextLayerProps> = ({ pageNum, pdfDoc, scale, width, height }) => {
  const [textItems, setTextItems] = useState<PositionedTextItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    const loadTextContent = async () => {
      if (!pdfDoc) {
        setTextItems([]);
        return;
      }

      try {
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();
        if (cancelled) return;

        setTextItems(
          textContent.items.filter(isTextItem).map((item) => {
            const [transformScaleX, transformSkewY, , transformY, transformX, transformTop] = item.transform;
            const fontSize = Math.abs(transformY) * scale || item.height * scale;
            const textHeight = item.height * scale || fontSize;

            return {
              text: item.str,
              left: transformX * scale,
              top: height - transformTop * scale - textHeight,
              fontSize,
              scaleX: Math.hypot(transformScaleX, transformSkewY) || 1,
            };
          }),
        );
      } catch (error) {
        if (!cancelled) {
          console.error(`Unable to load text for page ${pageNum}:`, error);
          setTextItems([]);
        }
      }
    };

    void loadTextContent();

    return () => {
      cancelled = true;
    };
  }, [height, pageNum, pdfDoc, scale, width]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width,
        height,
        overflow: 'hidden',
        pointerEvents: 'none',
        userSelect: 'text',
      }}
    >
      {textItems.map((item, index) => (
        <span
          key={`${index}-${item.left}-${item.top}`}
          style={{
            position: 'absolute',
            left: item.left,
            top: item.top,
            color: 'transparent',
            fontSize: item.fontSize,
            lineHeight: 1,
            pointerEvents: 'none',
            transform: `scaleX(${item.scaleX})`,
            transformOrigin: 'left top',
            whiteSpace: 'pre',
          }}
        >
          {item.text}
        </span>
      ))}
    </div>
  );
};
