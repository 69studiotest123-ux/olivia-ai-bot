import sys
from PIL import Image

def process_image(input_path, output_path):
    # Open the image and convert to RGBA
    img = Image.open(input_path).convert("RGBA")
    
    # Create a solid background image (#0a0a0c)
    background = Image.new("RGBA", img.size, (10, 10, 12, 255))
    
    # Composite the foreground over the background using alpha mask
    final = Image.alpha_composite(background, img)
    
    # Save as RGB (no transparency) to avoid iOS white background
    final.convert("RGB").save(output_path, "PNG")
    print(f"Saved to {output_path}")

if __name__ == "__main__":
    process_image("olivia.png", "apple-touch-icon.png")
