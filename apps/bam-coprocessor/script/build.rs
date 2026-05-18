use sp1_build::build_program_with_args;

fn main() {
    build_program_with_args("../program-reader", Default::default());
    build_program_with_args("../program-app", Default::default());
}
