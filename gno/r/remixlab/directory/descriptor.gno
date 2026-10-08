package directory

import "gno.land/p/remixlab/core/v1"

// configDigest is the canonical digest of the project configuration that
// produced this realm.
const configDigest = "sha256:a5e33a249ac22f2a87ddd0bba5f1104117061e3f32155d13e303f57ccaf704b8"

// Descriptor identifies this app's recipe and components.
func Descriptor() core.AppDescriptor {
	return core.AppDescriptor{
		Recipe:        recipeID,
		RecipeVersion: recipeVersion,
		Components: []string{
			"core@1.0.0",
			"forms@1.0.0",
			"membership@1.0.0",
			"policies@1.0.0",
			"render@1.0.0",
		},
		ConfigDigest:      configDigest,
		ViewSchemaVersion: core.ViewSchemaVersion,
		Bindings:          []string{"membership.read/v1=" + pkgPath},
	}
}
