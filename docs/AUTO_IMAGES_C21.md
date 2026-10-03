# Automatic team image preparation C-21
Owner request, 3 October 2026: team logo upload must automatically adapt image dimensions and file size without asking the user to resize it.
Client preparation compresses before sending, avoiding hosting request limits for ordinary large photos. Server decodes and normalizes brand images independently. Team/sponsor logos fit a transparent square without stretching or cutting off their artwork; team banners retain aspect ratio. Saved evidence originals are not modified.
Duplicate game-name input hides the add action; the server also keeps duplicate requests idempotent.
Verification: targeted image test and browser upload of a PNG larger than the hosting request limit; PASS. Duplicate-name action hidden in the real-browser test. Publication pending required CI.
