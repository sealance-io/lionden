program helloworld.aleo {
    @noupgrade
    constructor() {}

    fn main(public a: u32, b: u32) -> u32 {
        return a + b;
    }
}
