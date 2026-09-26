# Ultima Online client files (optional)

Without files here the server runs a synthetic flat arena (no terrain, no statics), which is
enough for the bots. For the real world and for ClassicUO, copy the contents of an Ultima
Online Classic installation into this folder (or point `UO_DATA_DIR` in `.env` at one).

EA only ships the Classic Client as a Windows installer (`UOClassicSetup_*.exe` from
https://uo.com/client-download/). Install it on any Windows machine once and copy the folder;
the data files themselves are the same on every platform. They are EA's copyright, so they are
git-ignored and never baked into an image.
