from flask import Flask, render_template
import os

app = Flask(__name__)

@app.route("/")
def index():
    image_folder = os.path.join(app.static_folder, "images", "animals")
    animal_images = [
        f for f in os.listdir(image_folder)
        if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))
    ]
    return render_template("index.html", animal_images=animal_images)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)